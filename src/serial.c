#include "serial.h"

#include <stdio.h>

void serial_outb(vmm_t *vmm, uint16_t port, uint8_t value)
{
    if (port != VMM_SERIAL_PORT) {
        return;
    }

    if (vmm->serial_len + 1 < sizeof(vmm->serial_buf)) {
        vmm->serial_buf[vmm->serial_len++] = (char)value;
        vmm->serial_buf[vmm->serial_len] = '\0';
    }

    fputc((int)value, stdout);
    fflush(stdout);
}

uint8_t serial_inb(vmm_t *vmm, uint16_t port)
{
    (void)vmm;
    /* Line Status Register: transmitter empty + holding register empty */
    if (port == VMM_SERIAL_PORT + 5) {
        return 0x60;
    }
    return 0xff;
}
