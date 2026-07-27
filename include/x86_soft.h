#ifndef OPEN_EMULATOR_X86_SOFT_H
#define OPEN_EMULATOR_X86_SOFT_H

#include "vmm.h"

/* Minimal real-mode-ish interpreter for the built-in guest payload. */
int soft_cpu_run(vmm_t *vmm, uint64_t entry);

#endif /* OPEN_EMULATOR_X86_SOFT_H */
