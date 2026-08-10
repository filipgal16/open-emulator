# open-vmm long-mode and virtio foundation

This phase adds passive scaffolding for moving `open-vmm` beyond the current
real-mode demo guest. The existing guest entry remains GPA `0x1000`.

## Done

- Long-mode memory structures are prepared in guest RAM during VMM init:
  - PML4 at GPA `0x2000`
  - GDT at GPA `0x3000`
  - PDPT at GPA `0x4000`
  - Page directory at GPA `0x5000`
- The page tables identity-map guest RAM with 2MiB pages, currently up to 1GiB.
- The GDT contains null, 64-bit code, and data descriptors.
- A virtio-mmio v2 stub exists at GPA `0x10001000`.
  - `MagicValue` reads as `0x74726976`.
  - `Version` reads as `2`.
  - Basic writable status/queue/feature-selection registers retain state.
- KVM MMIO exits targeting the virtio-mmio window are routed to the stub.
- The soft backend remains real-mode only, but the device model and long-mode
  tables are still testable without KVM.

## Next

- Add a 16-bit/32-bit trampoline that enables PAE, loads CR3, sets EFER.LME,
  enables paging, loads the GDT, and far-jumps to the 64-bit code selector.
- Extend KVM setup to install long-mode `sregs` directly for a 64-bit guest
  entry path when appropriate.
- Add virtqueue state, descriptor-ring validation, and at least one concrete
  virtio device implementation such as console, block, net, or input.
- Teach the soft backend about MMIO loads/stores if it grows beyond the current
  tiny real-mode instruction interpreter.
- Replace the flat demo guest with a boot path that can hand off to a kernel or
  Android-oriented loader.
