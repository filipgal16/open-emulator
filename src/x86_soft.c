/*
 * Minimal software CPU for the open-emulator guest payload.
 *
 * Supports just enough 16-bit real-mode opcodes for our hello guest.
 * This is not a full x86 emulator — it exists so the VMM can be
 * exercised when /dev/kvm is unavailable.
 */

#include "x86_soft.h"
#include "serial.h"

#include <stdio.h>
#include <string.h>

typedef struct {
    uint16_t ax, cx, dx, bx, sp, bp, si, di;
    uint16_t ip;
    uint16_t flags;
    uint16_t cs, ds, es, ss;
    bool halted;
} soft_cpu_t;

enum {
    FLAG_ZF = 1 << 6,
};

static uint8_t mem_read8(vmm_t *vmm, uint32_t phys)
{
    if ((size_t)phys >= vmm->ram_size) {
        return 0xff;
    }
    return vmm->ram[phys];
}

static uint32_t linear(uint16_t seg, uint16_t off)
{
    return ((uint32_t)seg << 4) + (uint32_t)off;
}

static uint8_t fetch8(vmm_t *vmm, soft_cpu_t *cpu)
{
    uint32_t addr = linear(cpu->cs, cpu->ip);
    uint8_t b = mem_read8(vmm, addr);
    cpu->ip++;
    return b;
}

static uint16_t fetch16(vmm_t *vmm, soft_cpu_t *cpu)
{
    uint8_t lo = fetch8(vmm, cpu);
    uint8_t hi = fetch8(vmm, cpu);
    return (uint16_t)lo | ((uint16_t)hi << 8);
}

static uint16_t *reg16(soft_cpu_t *cpu, int r)
{
    switch (r & 7) {
    case 0: return &cpu->ax;
    case 1: return &cpu->cx;
    case 2: return &cpu->dx;
    case 3: return &cpu->bx;
    case 4: return &cpu->sp;
    case 5: return &cpu->bp;
    case 6: return &cpu->si;
    default: return &cpu->di;
    }
}

static uint8_t *reg8(soft_cpu_t *cpu, int r)
{
    static uint8_t dummy;
    switch (r & 7) {
    case 0: return (uint8_t *)&cpu->ax;
    case 1: return (uint8_t *)&cpu->cx;
    case 2: return (uint8_t *)&cpu->dx;
    case 3: return (uint8_t *)&cpu->bx;
    case 4: return ((uint8_t *)&cpu->ax) + 1;
    case 5: return ((uint8_t *)&cpu->cx) + 1;
    case 6: return ((uint8_t *)&cpu->dx) + 1;
    case 7: return ((uint8_t *)&cpu->bx) + 1;
    default: return &dummy;
    }
}

static void set_zf(soft_cpu_t *cpu, bool zero)
{
    if (zero) {
        cpu->flags |= FLAG_ZF;
    } else {
        cpu->flags &= (uint16_t)~FLAG_ZF;
    }
}

/* 16-bit modrm effective address (mod != 3). */
static int ea16(vmm_t *vmm, soft_cpu_t *cpu, uint8_t modrm, uint32_t *out)
{
    int mod = (modrm >> 6) & 3;
    int rm = modrm & 7;
    uint16_t off = 0;

    switch (rm) {
    case 0: off = (uint16_t)(cpu->bx + cpu->si); break;
    case 1: off = (uint16_t)(cpu->bx + cpu->di); break;
    case 2: off = (uint16_t)(cpu->bp + cpu->si); break;
    case 3: off = (uint16_t)(cpu->bp + cpu->di); break;
    case 4: off = cpu->si; break;
    case 5: off = cpu->di; break;
    case 6:
        if (mod == 0) {
            off = fetch16(vmm, cpu);
        } else {
            off = cpu->bp;
        }
        break;
    case 7: off = cpu->bx; break;
    }

    if (mod == 1) {
        off = (uint16_t)(off + (int8_t)fetch8(vmm, cpu));
    } else if (mod == 2) {
        off = (uint16_t)(off + (int16_t)fetch16(vmm, cpu));
    }

    *out = linear(cpu->ds, off);
    return 0;
}

static int step(vmm_t *vmm, soft_cpu_t *cpu)
{
    uint8_t op = fetch8(vmm, cpu);

    switch (op) {
    case 0x90: /* NOP */
        return 0;

    case 0xb0: case 0xb1: case 0xb2: case 0xb3:
    case 0xb4: case 0xb5: case 0xb6: case 0xb7: {
        uint8_t imm = fetch8(vmm, cpu);
        *reg8(cpu, op - 0xb0) = imm;
        return 0;
    }

    case 0xb8: case 0xb9: case 0xba: case 0xbb:
    case 0xbc: case 0xbd: case 0xbe: case 0xbf: {
        uint16_t imm = fetch16(vmm, cpu);
        *reg16(cpu, op - 0xb8) = imm;
        return 0;
    }

    case 0x88: { /* MOV r/m8, r8 */
        uint8_t modrm = fetch8(vmm, cpu);
        int mod = (modrm >> 6) & 3;
        int reg = (modrm >> 3) & 7;
        int rm = modrm & 7;
        uint8_t src = *reg8(cpu, reg);
        if (mod == 3) {
            *reg8(cpu, rm) = src;
            return 0;
        }
        uint32_t addr;
        if (ea16(vmm, cpu, modrm, &addr) != 0) {
            return -1;
        }
        if ((size_t)addr < vmm->ram_size) {
            vmm->ram[addr] = src;
        }
        return 0;
    }

    case 0x8a: { /* MOV r8, r/m8 */
        uint8_t modrm = fetch8(vmm, cpu);
        int mod = (modrm >> 6) & 3;
        int reg = (modrm >> 3) & 7;
        int rm = modrm & 7;
        if (mod == 3) {
            *reg8(cpu, reg) = *reg8(cpu, rm);
            return 0;
        }
        uint32_t addr;
        if (ea16(vmm, cpu, modrm, &addr) != 0) {
            return -1;
        }
        *reg8(cpu, reg) = mem_read8(vmm, addr);
        return 0;
    }

    case 0x89: { /* MOV r/m16, r16 */
        uint8_t modrm = fetch8(vmm, cpu);
        int mod = (modrm >> 6) & 3;
        int reg = (modrm >> 3) & 7;
        int rm = modrm & 7;
        if (mod == 3) {
            *reg16(cpu, rm) = *reg16(cpu, reg);
            return 0;
        }
        fprintf(stderr, "soft-cpu: unsupported MOV 0x89 memory form\n");
        return -1;
    }

    case 0x8b: { /* MOV r16, r/m16 */
        uint8_t modrm = fetch8(vmm, cpu);
        int mod = (modrm >> 6) & 3;
        int reg = (modrm >> 3) & 7;
        int rm = modrm & 7;
        if (mod == 3) {
            *reg16(cpu, reg) = *reg16(cpu, rm);
            return 0;
        }
        fprintf(stderr, "soft-cpu: unsupported MOV 0x8b memory form\n");
        return -1;
    }

    case 0xa8: { /* TEST AL, imm8 */
        uint8_t imm = fetch8(vmm, cpu);
        set_zf(cpu, ((cpu->ax & 0xff) & imm) == 0);
        return 0;
    }

    case 0x84: { /* TEST r/m8, r8 */
        uint8_t modrm = fetch8(vmm, cpu);
        int mod = (modrm >> 6) & 3;
        int reg = (modrm >> 3) & 7;
        int rm = modrm & 7;
        uint8_t a, b = *reg8(cpu, reg);
        if (mod == 3) {
            a = *reg8(cpu, rm);
        } else {
            uint32_t addr;
            if (ea16(vmm, cpu, modrm, &addr) != 0) {
                return -1;
            }
            a = mem_read8(vmm, addr);
        }
        set_zf(cpu, (a & b) == 0);
        return 0;
    }

    case 0x46: /* INC SI */
        cpu->si++;
        set_zf(cpu, cpu->si == 0);
        return 0;

    case 0x40: case 0x41: case 0x42: case 0x43:
    case 0x44: case 0x45: case 0x47: {
        uint16_t *r = reg16(cpu, op - 0x40);
        (*r)++;
        set_zf(cpu, *r == 0);
        return 0;
    }

    case 0xac: { /* LODSB */
        uint8_t val = mem_read8(vmm, linear(cpu->ds, cpu->si));
        cpu->ax = (uint16_t)((cpu->ax & 0xff00) | val);
        cpu->si++;
        return 0;
    }

    case 0xe6: { /* OUT imm8, AL */
        uint8_t port = fetch8(vmm, cpu);
        serial_outb(vmm, port, (uint8_t)(cpu->ax & 0xff));
        return 0;
    }

    case 0xee: /* OUT DX, AL */
        serial_outb(vmm, cpu->dx, (uint8_t)(cpu->ax & 0xff));
        return 0;

    case 0xe4: {
        uint8_t port = fetch8(vmm, cpu);
        uint8_t val = serial_inb(vmm, port);
        cpu->ax = (uint16_t)((cpu->ax & 0xff00) | val);
        return 0;
    }

    case 0xec: {
        uint8_t val = serial_inb(vmm, cpu->dx);
        cpu->ax = (uint16_t)((cpu->ax & 0xff00) | val);
        return 0;
    }

    case 0xeb: {
        int8_t rel = (int8_t)fetch8(vmm, cpu);
        cpu->ip = (uint16_t)(cpu->ip + rel);
        return 0;
    }

    case 0xe9: {
        int16_t rel = (int16_t)fetch16(vmm, cpu);
        cpu->ip = (uint16_t)(cpu->ip + rel);
        return 0;
    }

    case 0x74: { /* JZ rel8 */
        int8_t rel = (int8_t)fetch8(vmm, cpu);
        if (cpu->flags & FLAG_ZF) {
            cpu->ip = (uint16_t)(cpu->ip + rel);
        }
        return 0;
    }

    case 0x75: { /* JNZ rel8 */
        int8_t rel = (int8_t)fetch8(vmm, cpu);
        if (!(cpu->flags & FLAG_ZF)) {
            cpu->ip = (uint16_t)(cpu->ip + rel);
        }
        return 0;
    }

    case 0xf4: /* HLT */
        cpu->halted = true;
        return 0;

    case 0xcd:
        (void)fetch8(vmm, cpu);
        return 0;

    default:
        fprintf(stderr,
                "soft-cpu: unhandled opcode 0x%02x at CS:IP=%04x:%04x\n",
                op, cpu->cs, (uint16_t)(cpu->ip - 1));
        return -1;
    }
}

int soft_cpu_run(vmm_t *vmm, uint64_t entry)
{
    soft_cpu_t cpu;
    memset(&cpu, 0, sizeof(cpu));

    cpu.cs = (uint16_t)(entry >> 4);
    cpu.ip = (uint16_t)(entry & 0xf);
    cpu.ds = cpu.cs;
    cpu.es = cpu.cs;
    cpu.ss = cpu.cs;
    cpu.sp = 0xfff0;
    cpu.dx = VMM_SERIAL_PORT;
    cpu.flags = 0x2;

    const int max_steps = 1000000;
    for (int i = 0; i < max_steps; i++) {
        if (cpu.halted) {
            vmm->exit_code = 0;
            return 0;
        }
        if (step(vmm, &cpu) != 0) {
            vmm->exit_code = 1;
            return -1;
        }
    }

    fprintf(stderr, "soft-cpu: exceeded max steps without HLT\n");
    vmm->exit_code = 2;
    return -1;
}
