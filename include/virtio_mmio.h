#ifndef OPEN_EMULATOR_VIRTIO_MMIO_H
#define OPEN_EMULATOR_VIRTIO_MMIO_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define VIRTIO_MMIO_DEFAULT_BASE 0x10001000ULL
#define VIRTIO_MMIO_REGION_SIZE  0x1000ULL

#define VIRTIO_MMIO_MAGIC_VALUE 0x74726976U
#define VIRTIO_MMIO_VERSION     2U
#define VIRTIO_MMIO_VENDOR_ID   0x4f564d4dU /* "OVMM" */

#define VIRTIO_MMIO_DEVICE_ID_NET 1U

#define VIRTIO_MMIO_REG_MAGIC_VALUE         0x000U
#define VIRTIO_MMIO_REG_VERSION             0x004U
#define VIRTIO_MMIO_REG_DEVICE_ID           0x008U
#define VIRTIO_MMIO_REG_VENDOR_ID           0x00cU
#define VIRTIO_MMIO_REG_DEVICE_FEATURES     0x010U
#define VIRTIO_MMIO_REG_DEVICE_FEATURES_SEL 0x014U
#define VIRTIO_MMIO_REG_DRIVER_FEATURES     0x020U
#define VIRTIO_MMIO_REG_DRIVER_FEATURES_SEL 0x024U
#define VIRTIO_MMIO_REG_QUEUE_SEL           0x030U
#define VIRTIO_MMIO_REG_QUEUE_NUM_MAX       0x034U
#define VIRTIO_MMIO_REG_QUEUE_NUM           0x038U
#define VIRTIO_MMIO_REG_QUEUE_READY         0x044U
#define VIRTIO_MMIO_REG_QUEUE_NOTIFY        0x050U
#define VIRTIO_MMIO_REG_INTERRUPT_STATUS    0x060U
#define VIRTIO_MMIO_REG_INTERRUPT_ACK       0x064U
#define VIRTIO_MMIO_REG_STATUS              0x070U

typedef struct {
    uint64_t base;
    uint32_t device_id;
    uint32_t vendor_id;
    uint32_t device_features_sel;
    uint32_t driver_features_sel;
    uint32_t driver_features;
    uint32_t queue_sel;
    uint32_t queue_num;
    uint32_t queue_ready;
    uint32_t queue_notify;
    uint32_t interrupt_status;
    uint32_t status;
} virtio_mmio_device_t;

void virtio_mmio_init(virtio_mmio_device_t *dev, uint64_t base, uint32_t device_id);
bool virtio_mmio_contains(const virtio_mmio_device_t *dev, uint64_t addr, size_t len);
uint32_t virtio_mmio_read32(const virtio_mmio_device_t *dev, uint64_t addr);
void virtio_mmio_write32(virtio_mmio_device_t *dev, uint64_t addr, uint32_t value);
int virtio_mmio_read(const virtio_mmio_device_t *dev, uint64_t addr, void *buf, size_t len);
int virtio_mmio_write(virtio_mmio_device_t *dev, uint64_t addr, const void *buf, size_t len);

#endif /* OPEN_EMULATOR_VIRTIO_MMIO_H */
