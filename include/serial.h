#ifndef OPEN_EMULATOR_SERIAL_H
#define OPEN_EMULATOR_SERIAL_H

#include "vmm.h"

void serial_outb(vmm_t *vmm, uint16_t port, uint8_t value);
uint8_t serial_inb(vmm_t *vmm, uint16_t port);

#endif /* OPEN_EMULATOR_SERIAL_H */
