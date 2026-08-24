/**
 * The QEMU command line for an Android-x86 guest.
 *
 * Kept apart from the process handling so it can be tested without QEMU installed — the flags are
 * where the mistakes live, not the spawning. Several of these are load-bearing in ways that are
 * invisible until the guest fails to boot, so each is explained where it is not obvious.
 */

export type QemuAccel = 'whpx' | 'tcg';

export interface QemuArgsInput {
  /** Extracted from the ISO, not booted through its menu — see `kernel`/`initrd` below. */
  kernelPath: string;
  initrdPath: string;
  isoPath: string;
  dataDiskPath: string;
  /** `SRC=` — the directory on the media holding the payload. Empty for an ISO release. */
  srcDir: string;
  cores: number;
  ramMb: number;
  accel: QemuAccel;
  /** Host port forwarded to the guest's adb. */
  adbPort: number;
  /** A window to embed, or headless. */
  headless: boolean;
  /** Serial console output, for diagnosing a boot that never completes. */
  logPath?: string;
}

/**
 * The device Android-x86's initrd is told to mount at `/data`.
 *
 * The data disk is the only virtio block device attached, so it is always `/dev/vda`. Attaching
 * anything else on virtio would shift this and the guest would mount the wrong thing.
 */
export const DATA_DEVICE = '/dev/vda';

/**
 * The kernel command line handed to Android-x86.
 *
 * `SRC=` names the directory holding `system.sfs` as an absolute path from the media root, which is
 * why it is derived from the ISO rather than assumed — an ISO release keeps the payload at the
 * root and an installed layout does not.
 *
 * `nomodeset` matters more than it looks: without it the guest tries to bring up KMS against a
 * virtual GPU and can land on a black screen that looks like a hang rather than a graphics
 * failure.
 */
export function kernelCommandLine(input: Pick<QemuArgsInput, 'srcDir'>): string {
  return [
    'root=/dev/ram0',
    // Android-x86 will not complete boot with SELinux enforcing under QEMU.
    'androidboot.selinux=permissive',
    `SRC=${input.srcDir}`,
    `DATA=${DATA_DEVICE}`,
    'console=ttyS0',
    'nomodeset',
  ].join(' ');
}

export function qemuArgs(input: QemuArgsInput): string[] {
  const args: string[] = [];

  // Acceleration first: everything else is irrelevant if the guest is interpreting instructions.
  if (input.accel === 'whpx') {
    // `,kernel-irqchip=off` is required — WHPX does not implement the in-kernel interrupt
    // controller, and QEMU fails to start rather than falling back.
    args.push('-accel', 'whpx,kernel-irqchip=off', '-cpu', 'max,-vmx,-svm');
  } else {
    args.push('-accel', 'tcg', '-cpu', 'qemu64');
  }

  args.push('-smp', String(input.cores), '-m', String(input.ramMb));

  /**
   * Booted directly from the extracted kernel and initrd rather than through the ISO's boot menu.
   *
   * The menu needs someone to press a key, and this has to come up unattended — which is the whole
   * reason the ISO is parsed for these two files instead of simply being handed to QEMU as a
   * bootable disc.
   */
  args.push('-kernel', input.kernelPath, '-initrd', input.initrdPath, '-append', kernelCommandLine(input));

  // The ISO stays attached: the kernel and initrd came out of it, but `system.sfs` is still read
  // from the media at runtime.
  args.push('-drive', `file=${input.isoPath},media=cdrom,readonly=on`);
  args.push('-drive', `file=${input.dataDiskPath},format=qcow2,if=virtio`);

  // adb over TCP, forwarded from the host. There is no USB to emulate.
  args.push('-netdev', `user,id=n0,hostfwd=tcp::${input.adbPort}-:5555`, '-device', 'virtio-net-pci,netdev=n0');

  if (input.headless) {
    args.push('-display', 'none');
  } else {
    // SDL gives an ordinary top-level window, which is what the embedding code reparents.
    args.push('-display', 'sdl', '-device', 'virtio-vga');
  }

  if (input.logPath) args.push('-serial', `file:${input.logPath}`);

  return args;
}

/** `qemu-img` arguments for the guest's `/data` disk. */
export function createDataDiskArgs(diskPath: string, sizeGb: number): string[] {
  return ['create', '-f', 'qcow2', diskPath, `${sizeGb}G`];
}
