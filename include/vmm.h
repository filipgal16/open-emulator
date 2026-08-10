#ifndef OPEN_EMULATOR_VMM_H
#define OPEN_EMULATOR_VMM_H

#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>

#include "virtio_mmio.h"

#define VMM_DEFAULT_RAM_SIZE (16UL * 1024UL * 1024UL) /* 16 MiB */
#define VMM_GUEST_ENTRY     0x1000ULL
#define VMM_SERIAL_PORT     0x3f8
#define VMM_VIRTIO_MMIO_BASE VIRTIO_MMIO_DEFAULT_BASE

typedef enum {
    VMM_BACKEND_AUTO = 0,
    VMM_BACKEND_KVM,
    VMM_BACKEND_SOFT,
} vmm_backend_kind;

typedef struct {
    uint8_t *ram;
    size_t ram_size;
    vmm_backend_kind backend;
    int kvm_fd;
    int vm_fd;
    int vcpu_fd;
    void *kvm_run;
    size_t kvm_run_size;
    bool running;
    int exit_code;
    char serial_buf[4096];
    size_t serial_len;
    virtio_mmio_device_t virtio_mmio;
} vmm_t;

int vmm_init(vmm_t *vmm, size_t ram_size, vmm_backend_kind kind);
void vmm_destroy(vmm_t *vmm);

int vmm_load_flat_binary(vmm_t *vmm, const char *path, uint64_t guest_addr);
int vmm_long_mode_prepare(vmm_t *vmm);
int vmm_run(vmm_t *vmm);

const char *vmm_backend_name(const vmm_t *vmm);
bool vmm_kvm_available(void);

#endif /* OPEN_EMULATOR_VMM_H */
