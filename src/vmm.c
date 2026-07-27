#define _GNU_SOURCE

#include "vmm.h"
#include "serial.h"
#include "x86_soft.h"

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

#ifdef __linux__
# include <linux/kvm.h>
# define HAVE_LINUX_KVM 1
#else
# define HAVE_LINUX_KVM 0
#endif

bool vmm_kvm_available(void)
{
#if HAVE_LINUX_KVM
    int fd = open("/dev/kvm", O_RDWR | O_CLOEXEC);
    if (fd < 0) {
        return false;
    }
    close(fd);
    return true;
#else
    return false;
#endif
}

const char *vmm_backend_name(const vmm_t *vmm)
{
    switch (vmm->backend) {
    case VMM_BACKEND_KVM:
        return "kvm";
    case VMM_BACKEND_SOFT:
        return "soft";
    default:
        return "unknown";
    }
}

static int vmm_alloc_ram(vmm_t *vmm, size_t ram_size)
{
    void *mem = mmap(NULL, ram_size, PROT_READ | PROT_WRITE,
                     MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (mem == MAP_FAILED) {
        perror("mmap guest ram");
        return -1;
    }
    memset(mem, 0, ram_size);
    vmm->ram = mem;
    vmm->ram_size = ram_size;
    return 0;
}

#if HAVE_LINUX_KVM
static int kvm_setup(vmm_t *vmm)
{
    int api;

    vmm->kvm_fd = open("/dev/kvm", O_RDWR | O_CLOEXEC);
    if (vmm->kvm_fd < 0) {
        perror("open /dev/kvm");
        return -1;
    }

    api = ioctl(vmm->kvm_fd, KVM_GET_API_VERSION, 0);
    if (api != KVM_API_VERSION) {
        fprintf(stderr, "kvm: unexpected API version %d (want %d)\n",
                api, KVM_API_VERSION);
        return -1;
    }

    vmm->vm_fd = ioctl(vmm->kvm_fd, KVM_CREATE_VM, 0);
    if (vmm->vm_fd < 0) {
        perror("KVM_CREATE_VM");
        return -1;
    }

    struct kvm_userspace_memory_region region = {
        .slot = 0,
        .flags = 0,
        .guest_phys_addr = 0,
        .memory_size = vmm->ram_size,
        .userspace_addr = (uint64_t)(uintptr_t)vmm->ram,
    };
    if (ioctl(vmm->vm_fd, KVM_SET_USER_MEMORY_REGION, &region) < 0) {
        perror("KVM_SET_USER_MEMORY_REGION");
        return -1;
    }

    vmm->vcpu_fd = ioctl(vmm->vm_fd, KVM_CREATE_VCPU, 0);
    if (vmm->vcpu_fd < 0) {
        perror("KVM_CREATE_VCPU");
        return -1;
    }

    int mmap_size = ioctl(vmm->kvm_fd, KVM_GET_VCPU_MMAP_SIZE, 0);
    if (mmap_size < 0) {
        perror("KVM_GET_VCPU_MMAP_SIZE");
        return -1;
    }
    vmm->kvm_run_size = (size_t)mmap_size;
    vmm->kvm_run = mmap(NULL, vmm->kvm_run_size, PROT_READ | PROT_WRITE,
                        MAP_SHARED, vmm->vcpu_fd, 0);
    if (vmm->kvm_run == MAP_FAILED) {
        perror("mmap kvm_run");
        vmm->kvm_run = NULL;
        return -1;
    }

    return 0;
}

static int kvm_reset_vcpu(vmm_t *vmm, uint64_t entry)
{
    struct kvm_sregs sregs;
    struct kvm_regs regs;

    if (ioctl(vmm->vcpu_fd, KVM_GET_SREGS, &sregs) < 0) {
        perror("KVM_GET_SREGS");
        return -1;
    }

    /* Real mode: CS base = entry & ~0xf, IP = entry & 0xf */
    sregs.cs.base = entry & ~0xfull;
    sregs.cs.selector = (uint16_t)((entry >> 4) & 0xffff);
    sregs.cs.limit = 0xffff;
    sregs.cs.type = 0xb;
    sregs.cs.present = 1;
    sregs.cs.dpl = 0;
    sregs.cs.db = 0;
    sregs.cs.s = 1;
    sregs.cs.l = 0;
    sregs.cs.g = 0;
    sregs.cs.avl = 0;

    sregs.ds = sregs.es = sregs.fs = sregs.gs = sregs.ss = sregs.cs;
    sregs.ds.base = sregs.es.base = sregs.fs.base =
        sregs.gs.base = sregs.ss.base = sregs.cs.base;
    sregs.ds.selector = sregs.es.selector = sregs.fs.selector =
        sregs.gs.selector = sregs.ss.selector = sregs.cs.selector;

    sregs.cr0 &= ~(1u << 0); /* clear PE → real mode */
    sregs.efer = 0;

    if (ioctl(vmm->vcpu_fd, KVM_SET_SREGS, &sregs) < 0) {
        perror("KVM_SET_SREGS");
        return -1;
    }

    memset(&regs, 0, sizeof(regs));
    regs.rflags = 0x2; /* reserved bit must be set */
    regs.rip = entry & 0xfull;
    regs.rsp = 0xfff0;
    regs.rdx = VMM_SERIAL_PORT;

    if (ioctl(vmm->vcpu_fd, KVM_SET_REGS, &regs) < 0) {
        perror("KVM_SET_REGS");
        return -1;
    }

    return 0;
}

static int kvm_handle_io(vmm_t *vmm, struct kvm_run *run)
{
    if (run->io.direction == KVM_EXIT_IO_OUT) {
        uint8_t *data = (uint8_t *)run + run->io.data_offset;
        for (uint32_t i = 0; i < run->io.count; i++) {
            if (run->io.size == 1) {
                serial_outb(vmm, run->io.port, data[i]);
            }
        }
        return 0;
    }

    if (run->io.direction == KVM_EXIT_IO_IN) {
        uint8_t *data = (uint8_t *)run + run->io.data_offset;
        for (uint32_t i = 0; i < run->io.count; i++) {
            if (run->io.size == 1) {
                data[i] = serial_inb(vmm, run->io.port);
            }
        }
        return 0;
    }

    return 0;
}

static int kvm_run_loop(vmm_t *vmm)
{
    struct kvm_run *run = vmm->kvm_run;

    vmm->running = true;
    while (vmm->running) {
        if (ioctl(vmm->vcpu_fd, KVM_RUN, 0) < 0) {
            if (errno == EINTR) {
                continue;
            }
            perror("KVM_RUN");
            vmm->exit_code = 1;
            return -1;
        }

        switch (run->exit_reason) {
        case KVM_EXIT_IO:
            if (kvm_handle_io(vmm, run) != 0) {
                vmm->exit_code = 1;
                return -1;
            }
            break;

        case KVM_EXIT_HLT:
            vmm->running = false;
            vmm->exit_code = 0;
            break;

        case KVM_EXIT_SHUTDOWN:
            vmm->running = false;
            vmm->exit_code = 0;
            break;

        case KVM_EXIT_INTERNAL_ERROR:
            fprintf(stderr, "kvm: internal error suberror=%u\n",
                    run->internal.suberror);
            vmm->exit_code = 1;
            return -1;

        case KVM_EXIT_FAIL_ENTRY:
            fprintf(stderr, "kvm: fail entry hardware_entry_failure_reason=0x%llx\n",
                    (unsigned long long)run->fail_entry.hardware_entry_failure_reason);
            vmm->exit_code = 1;
            return -1;

        default:
            fprintf(stderr, "kvm: unhandled exit reason %u\n", run->exit_reason);
            vmm->exit_code = 1;
            return -1;
        }
    }

    return 0;
}
#endif /* HAVE_LINUX_KVM */

int vmm_init(vmm_t *vmm, size_t ram_size, vmm_backend_kind kind)
{
    memset(vmm, 0, sizeof(*vmm));
    vmm->kvm_fd = -1;
    vmm->vm_fd = -1;
    vmm->vcpu_fd = -1;

    if (ram_size == 0) {
        ram_size = VMM_DEFAULT_RAM_SIZE;
    }

    if (vmm_alloc_ram(vmm, ram_size) != 0) {
        return -1;
    }

    if (kind == VMM_BACKEND_AUTO) {
        kind = vmm_kvm_available() ? VMM_BACKEND_KVM : VMM_BACKEND_SOFT;
    }

    vmm->backend = kind;

#if HAVE_LINUX_KVM
    if (kind == VMM_BACKEND_KVM) {
        if (kvm_setup(vmm) != 0) {
            fprintf(stderr, "kvm setup failed; falling back to soft CPU\n");
            vmm->backend = VMM_BACKEND_SOFT;
            if (vmm->kvm_run) {
                munmap(vmm->kvm_run, vmm->kvm_run_size);
                vmm->kvm_run = NULL;
            }
            if (vmm->vcpu_fd >= 0) {
                close(vmm->vcpu_fd);
                vmm->vcpu_fd = -1;
            }
            if (vmm->vm_fd >= 0) {
                close(vmm->vm_fd);
                vmm->vm_fd = -1;
            }
            if (vmm->kvm_fd >= 0) {
                close(vmm->kvm_fd);
                vmm->kvm_fd = -1;
            }
        }
    }
#else
    if (kind == VMM_BACKEND_KVM) {
        fprintf(stderr, "KVM not supported on this platform; using soft CPU\n");
        vmm->backend = VMM_BACKEND_SOFT;
    }
#endif

    return 0;
}

void vmm_destroy(vmm_t *vmm)
{
    if (!vmm) {
        return;
    }

#if HAVE_LINUX_KVM
    if (vmm->kvm_run) {
        munmap(vmm->kvm_run, vmm->kvm_run_size);
        vmm->kvm_run = NULL;
    }
    if (vmm->vcpu_fd >= 0) {
        close(vmm->vcpu_fd);
        vmm->vcpu_fd = -1;
    }
    if (vmm->vm_fd >= 0) {
        close(vmm->vm_fd);
        vmm->vm_fd = -1;
    }
    if (vmm->kvm_fd >= 0) {
        close(vmm->kvm_fd);
        vmm->kvm_fd = -1;
    }
#endif

    if (vmm->ram) {
        munmap(vmm->ram, vmm->ram_size);
        vmm->ram = NULL;
    }
}

int vmm_load_flat_binary(vmm_t *vmm, const char *path, uint64_t guest_addr)
{
    FILE *f = fopen(path, "rb");
    if (!f) {
        perror(path);
        return -1;
    }

    if (fseek(f, 0, SEEK_END) != 0) {
        perror("fseek");
        fclose(f);
        return -1;
    }
    long sz = ftell(f);
    if (sz < 0) {
        perror("ftell");
        fclose(f);
        return -1;
    }
    rewind(f);

    if (guest_addr + (uint64_t)sz > vmm->ram_size) {
        fprintf(stderr, "guest binary does not fit in RAM\n");
        fclose(f);
        return -1;
    }

    size_t n = fread(vmm->ram + guest_addr, 1, (size_t)sz, f);
    fclose(f);
    if (n != (size_t)sz) {
        fprintf(stderr, "short read loading guest binary\n");
        return -1;
    }

    return 0;
}

int vmm_run(vmm_t *vmm)
{
    fprintf(stderr, "vmm: backend=%s ram=%zu entry=0x%llx\n",
            vmm_backend_name(vmm), vmm->ram_size,
            (unsigned long long)VMM_GUEST_ENTRY);

#if HAVE_LINUX_KVM
    if (vmm->backend == VMM_BACKEND_KVM) {
        if (kvm_reset_vcpu(vmm, VMM_GUEST_ENTRY) != 0) {
            return -1;
        }
        return kvm_run_loop(vmm);
    }
#endif

    return soft_cpu_run(vmm, VMM_GUEST_ENTRY);
}
