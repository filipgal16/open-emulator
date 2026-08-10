#ifndef OPEN_EMULATOR_X86_LONG_H
#define OPEN_EMULATOR_X86_LONG_H

#include "vmm.h"

#include <stddef.h>
#include <stdint.h>

#define X86_LONG_PML4_GPA 0x2000ULL
#define X86_LONG_GDT_GPA  0x3000ULL
#define X86_LONG_PDPT_GPA 0x4000ULL
#define X86_LONG_PD_GPA   0x5000ULL

#define X86_LONG_PAGE_SIZE          4096ULL
#define X86_LONG_LARGE_PAGE_SIZE    (2ULL * 1024ULL * 1024ULL)
#define X86_LONG_IDENTITY_MAP_LIMIT (1ULL * 1024ULL * 1024ULL * 1024ULL)

#define X86_LONG_PAGE_PRESENT (1ULL << 0)
#define X86_LONG_PAGE_RW      (1ULL << 1)
#define X86_LONG_PAGE_PS      (1ULL << 7)

#define X86_LONG_CODE64_SELECTOR 0x08U
#define X86_LONG_DATA_SELECTOR   0x10U

#define X86_LONG_GDT_ENTRIES 3U

int vmm_long_mode_prepare(vmm_t *vmm);

uint64_t x86_long_gdt_descriptor_code64(void);
uint64_t x86_long_gdt_descriptor_data(void);
size_t x86_long_identity_pd_entries(size_t ram_size);

#endif /* OPEN_EMULATOR_X86_LONG_H */
