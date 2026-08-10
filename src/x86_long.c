#include "x86_long.h"

#include <stdio.h>
#include <string.h>

static int guest_range_ok(const vmm_t *vmm, uint64_t gpa, size_t len)
{
    return gpa <= vmm->ram_size && len <= vmm->ram_size - (size_t)gpa;
}

static void write_u64(vmm_t *vmm, uint64_t gpa, uint64_t value)
{
    memcpy(vmm->ram + gpa, &value, sizeof(value));
}

uint64_t x86_long_gdt_descriptor_code64(void)
{
    return 0x00af9a000000ffffULL;
}

uint64_t x86_long_gdt_descriptor_data(void)
{
    return 0x00cf92000000ffffULL;
}

size_t x86_long_identity_pd_entries(size_t ram_size)
{
    uint64_t entries;

    if (ram_size == 0) {
        return 0;
    }

    entries = ((uint64_t)ram_size + X86_LONG_LARGE_PAGE_SIZE - 1) /
              X86_LONG_LARGE_PAGE_SIZE;
    if (entries > 512) {
        entries = 512;
    }
    return (size_t)entries;
}

int vmm_long_mode_prepare(vmm_t *vmm)
{
    size_t pd_entries;

    if (!vmm || !vmm->ram) {
        return -1;
    }
    if (!guest_range_ok(vmm, X86_LONG_PML4_GPA, X86_LONG_PAGE_SIZE) ||
        !guest_range_ok(vmm, X86_LONG_GDT_GPA, X86_LONG_PAGE_SIZE) ||
        !guest_range_ok(vmm, X86_LONG_PDPT_GPA, X86_LONG_PAGE_SIZE) ||
        !guest_range_ok(vmm, X86_LONG_PD_GPA, X86_LONG_PAGE_SIZE)) {
        fprintf(stderr, "long-mode setup does not fit in guest RAM\n");
        return -1;
    }
    memset(vmm->ram + X86_LONG_PML4_GPA, 0, X86_LONG_PAGE_SIZE);
    memset(vmm->ram + X86_LONG_GDT_GPA, 0, X86_LONG_PAGE_SIZE);
    memset(vmm->ram + X86_LONG_PDPT_GPA, 0, X86_LONG_PAGE_SIZE);
    memset(vmm->ram + X86_LONG_PD_GPA, 0, X86_LONG_PAGE_SIZE);

    write_u64(vmm, X86_LONG_PML4_GPA,
              X86_LONG_PDPT_GPA | X86_LONG_PAGE_PRESENT | X86_LONG_PAGE_RW);
    write_u64(vmm, X86_LONG_PDPT_GPA,
              X86_LONG_PD_GPA | X86_LONG_PAGE_PRESENT | X86_LONG_PAGE_RW);

    pd_entries = x86_long_identity_pd_entries(vmm->ram_size);
    for (size_t i = 0; i < pd_entries; i++) {
        uint64_t gpa = (uint64_t)i * X86_LONG_LARGE_PAGE_SIZE;
        uint64_t entry = gpa | X86_LONG_PAGE_PRESENT | X86_LONG_PAGE_RW |
                         X86_LONG_PAGE_PS;
        write_u64(vmm, X86_LONG_PD_GPA + i * sizeof(uint64_t), entry);
    }

    write_u64(vmm, X86_LONG_GDT_GPA + 0 * sizeof(uint64_t), 0);
    write_u64(vmm, X86_LONG_GDT_GPA + 1 * sizeof(uint64_t),
              x86_long_gdt_descriptor_code64());
    write_u64(vmm, X86_LONG_GDT_GPA + 2 * sizeof(uint64_t),
              x86_long_gdt_descriptor_data());

    return 0;
}
