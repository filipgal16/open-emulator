#include "vmm.h"

#include <getopt.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void usage(const char *argv0)
{
    fprintf(stderr,
            "Usage: %s [options] <guest.bin>\n"
            "\n"
            "Minimal Type-2 VMM for open-emulator (step 1: hypervisor).\n"
            "\n"
            "Options:\n"
            "  -b, --backend=auto|kvm|soft   CPU backend (default: auto)\n"
            "  -m, --memory=MiB              Guest RAM in MiB (default: 16)\n"
            "  -h, --help                    Show this help\n"
            "\n"
            "The guest is a flat binary loaded at GPA 0x%llx and run until HLT.\n"
            "Serial output on port 0x3f8 is printed to stdout.\n",
            argv0, (unsigned long long)VMM_GUEST_ENTRY);
}

static vmm_backend_kind parse_backend(const char *s)
{
    if (strcmp(s, "auto") == 0) {
        return VMM_BACKEND_AUTO;
    }
    if (strcmp(s, "kvm") == 0) {
        return VMM_BACKEND_KVM;
    }
    if (strcmp(s, "soft") == 0) {
        return VMM_BACKEND_SOFT;
    }
    fprintf(stderr, "unknown backend '%s'\n", s);
    exit(2);
}

int main(int argc, char **argv)
{
    vmm_backend_kind backend = VMM_BACKEND_AUTO;
    size_t ram_mib = 16;
    const char *guest_path = NULL;

    static struct option long_opts[] = {
        {"backend", required_argument, 0, 'b'},
        {"memory", required_argument, 0, 'm'},
        {"help", no_argument, 0, 'h'},
        {0, 0, 0, 0},
    };

    int c;
    while ((c = getopt_long(argc, argv, "b:m:h", long_opts, NULL)) != -1) {
        switch (c) {
        case 'b':
            backend = parse_backend(optarg);
            break;
        case 'm':
            ram_mib = (size_t)strtoul(optarg, NULL, 0);
            if (ram_mib == 0) {
                fprintf(stderr, "memory must be > 0\n");
                return 2;
            }
            break;
        case 'h':
            usage(argv[0]);
            return 0;
        default:
            usage(argv[0]);
            return 2;
        }
    }

    if (optind >= argc) {
        usage(argv[0]);
        return 2;
    }
    guest_path = argv[optind];

    fprintf(stderr, "open-emulator VMM\n");
    fprintf(stderr, "  kvm available: %s\n", vmm_kvm_available() ? "yes" : "no");

    vmm_t vmm;
    if (vmm_init(&vmm, ram_mib * 1024UL * 1024UL, backend) != 0) {
        return 1;
    }

    if (vmm_load_flat_binary(&vmm, guest_path, VMM_GUEST_ENTRY) != 0) {
        vmm_destroy(&vmm);
        return 1;
    }

    int rc = vmm_run(&vmm);

    fprintf(stderr, "\nvmm: exited rc=%d exit_code=%d serial_bytes=%zu\n",
            rc, vmm.exit_code, vmm.serial_len);

    int exit_code = (rc != 0) ? 1 : vmm.exit_code;
    vmm_destroy(&vmm);
    return exit_code;
}
