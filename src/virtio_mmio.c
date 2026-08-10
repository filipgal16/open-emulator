#include "virtio_mmio.h"

#include <string.h>

void virtio_mmio_init(virtio_mmio_device_t *dev, uint64_t base, uint32_t device_id)
{
    memset(dev, 0, sizeof(*dev));
    dev->base = base;
    dev->device_id = device_id;
    dev->vendor_id = VIRTIO_MMIO_VENDOR_ID;
}

bool virtio_mmio_contains(const virtio_mmio_device_t *dev, uint64_t addr, size_t len)
{
    uint64_t end;
    uint64_t region_end;

    if (!dev || len == 0 || addr < dev->base) {
        return false;
    }

    end = addr + (uint64_t)len;
    region_end = dev->base + VIRTIO_MMIO_REGION_SIZE;
    if (end < addr) {
        return false;
    }
    return end <= region_end;
}

uint32_t virtio_mmio_read32(const virtio_mmio_device_t *dev, uint64_t addr)
{
    uint32_t offset = (uint32_t)(addr - dev->base);

    switch (offset) {
    case VIRTIO_MMIO_REG_MAGIC_VALUE:
        return VIRTIO_MMIO_MAGIC_VALUE;
    case VIRTIO_MMIO_REG_VERSION:
        return VIRTIO_MMIO_VERSION;
    case VIRTIO_MMIO_REG_DEVICE_ID:
        return dev->device_id;
    case VIRTIO_MMIO_REG_VENDOR_ID:
        return dev->vendor_id;
    case VIRTIO_MMIO_REG_DEVICE_FEATURES:
        return 0;
    case VIRTIO_MMIO_REG_DEVICE_FEATURES_SEL:
        return dev->device_features_sel;
    case VIRTIO_MMIO_REG_DRIVER_FEATURES:
        return dev->driver_features;
    case VIRTIO_MMIO_REG_DRIVER_FEATURES_SEL:
        return dev->driver_features_sel;
    case VIRTIO_MMIO_REG_QUEUE_SEL:
        return dev->queue_sel;
    case VIRTIO_MMIO_REG_QUEUE_NUM_MAX:
        return 0;
    case VIRTIO_MMIO_REG_QUEUE_NUM:
        return dev->queue_num;
    case VIRTIO_MMIO_REG_QUEUE_READY:
        return dev->queue_ready;
    case VIRTIO_MMIO_REG_QUEUE_NOTIFY:
        return dev->queue_notify;
    case VIRTIO_MMIO_REG_INTERRUPT_STATUS:
        return dev->interrupt_status;
    case VIRTIO_MMIO_REG_STATUS:
        return dev->status;
    default:
        return 0;
    }
}

void virtio_mmio_write32(virtio_mmio_device_t *dev, uint64_t addr, uint32_t value)
{
    uint32_t offset = (uint32_t)(addr - dev->base);

    switch (offset) {
    case VIRTIO_MMIO_REG_DEVICE_FEATURES_SEL:
        dev->device_features_sel = value;
        break;
    case VIRTIO_MMIO_REG_DRIVER_FEATURES:
        dev->driver_features = value;
        break;
    case VIRTIO_MMIO_REG_DRIVER_FEATURES_SEL:
        dev->driver_features_sel = value;
        break;
    case VIRTIO_MMIO_REG_QUEUE_SEL:
        dev->queue_sel = value;
        break;
    case VIRTIO_MMIO_REG_QUEUE_NUM:
        dev->queue_num = value;
        break;
    case VIRTIO_MMIO_REG_QUEUE_READY:
        dev->queue_ready = value;
        break;
    case VIRTIO_MMIO_REG_QUEUE_NOTIFY:
        dev->queue_notify = value;
        break;
    case VIRTIO_MMIO_REG_INTERRUPT_ACK:
        dev->interrupt_status &= ~value;
        break;
    case VIRTIO_MMIO_REG_STATUS:
        dev->status = value;
        break;
    default:
        break;
    }
}

int virtio_mmio_read(const virtio_mmio_device_t *dev, uint64_t addr, void *buf, size_t len)
{
    uint8_t *out = buf;

    if (!virtio_mmio_contains(dev, addr, len)) {
        return -1;
    }

    for (size_t i = 0; i < len; i++) {
        uint64_t byte_addr = addr + (uint64_t)i;
        uint64_t reg_addr = byte_addr & ~0x3ULL;
        unsigned shift = (unsigned)((byte_addr & 0x3ULL) * 8);
        out[i] = (uint8_t)(virtio_mmio_read32(dev, reg_addr) >> shift);
    }
    return 0;
}

int virtio_mmio_write(virtio_mmio_device_t *dev, uint64_t addr, const void *buf, size_t len)
{
    const uint8_t *in = buf;

    if (!virtio_mmio_contains(dev, addr, len)) {
        return -1;
    }

    for (size_t i = 0; i < len; i++) {
        uint64_t byte_addr = addr + (uint64_t)i;
        uint64_t reg_addr = byte_addr & ~0x3ULL;
        unsigned shift = (unsigned)((byte_addr & 0x3ULL) * 8);
        uint32_t value = virtio_mmio_read32(dev, reg_addr);
        value &= ~(0xffU << shift);
        value |= (uint32_t)in[i] << shift;
        virtio_mmio_write32(dev, reg_addr, value);
    }
    return 0;
}
