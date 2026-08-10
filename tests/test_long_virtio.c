#include "virtio_mmio.h"
#include "vmm.h"
#include "x86_long.h"

#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

static uint64_t read_u64(const vmm_t *vmm, uint64_t gpa)
{
    uint64_t value;

    memcpy(&value, vmm->ram + gpa, sizeof(value));
    return value;
}

int main(void)
{
    vmm_t vmm;

    assert(vmm_init(&vmm, VMM_DEFAULT_RAM_SIZE, VMM_BACKEND_SOFT) == 0);

    assert(read_u64(&vmm, X86_LONG_PML4_GPA) ==
           (X86_LONG_PDPT_GPA | X86_LONG_PAGE_PRESENT | X86_LONG_PAGE_RW));
    assert(read_u64(&vmm, X86_LONG_PDPT_GPA) ==
           (X86_LONG_PD_GPA | X86_LONG_PAGE_PRESENT | X86_LONG_PAGE_RW));
    assert(read_u64(&vmm, X86_LONG_PD_GPA) ==
           (X86_LONG_PAGE_PRESENT | X86_LONG_PAGE_RW | X86_LONG_PAGE_PS));
    assert(read_u64(&vmm, X86_LONG_PD_GPA + sizeof(uint64_t)) ==
           (X86_LONG_LARGE_PAGE_SIZE | X86_LONG_PAGE_PRESENT |
            X86_LONG_PAGE_RW | X86_LONG_PAGE_PS));

    assert(read_u64(&vmm, X86_LONG_GDT_GPA) == 0);
    assert(read_u64(&vmm, X86_LONG_GDT_GPA + sizeof(uint64_t)) ==
           x86_long_gdt_descriptor_code64());
    assert(read_u64(&vmm, X86_LONG_GDT_GPA + 2 * sizeof(uint64_t)) ==
           x86_long_gdt_descriptor_data());

    assert(vmm.virtio_mmio.base == VMM_VIRTIO_MMIO_BASE);
    assert(virtio_mmio_read32(&vmm.virtio_mmio, VMM_VIRTIO_MMIO_BASE +
                              VIRTIO_MMIO_REG_MAGIC_VALUE) ==
           VIRTIO_MMIO_MAGIC_VALUE);
    assert(virtio_mmio_read32(&vmm.virtio_mmio, VMM_VIRTIO_MMIO_BASE +
                              VIRTIO_MMIO_REG_VERSION) ==
           VIRTIO_MMIO_VERSION);

    vmm_destroy(&vmm);
    puts("test_long_virtio: ok");
    return 0;
}
