//! The QEMU command line for an Android-x86 guest: the licence-clean route that the
//! `android/foss` prototype boots, kept for when a QEMU engine is wired in.
//!
//! Kept apart from the process handling so it can be tested without QEMU installed: the flags are
//! where the mistakes live, not the spawning. Several of these are load-bearing in ways that are
//! invisible until the guest fails to boot, so each is explained where it is not obvious.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QemuAccel {
    Whpx,
    Tcg,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QemuArgsInput {
    /// Extracted from the ISO, not booted through its menu: see `kernel`/`initrd` below.
    pub kernel_path: String,
    pub initrd_path: String,
    pub iso_path: String,
    pub data_disk_path: String,
    /// `SRC=`: the directory on the media holding the payload. Empty for an ISO release.
    pub src_dir: String,
    pub cores: u32,
    pub ram_mb: u32,
    pub accel: QemuAccel,
    /// Host port forwarded to the guest's adb.
    pub adb_port: u16,
    /// A window to embed, or headless.
    pub headless: bool,
    /// Serial console output, for diagnosing a boot that never completes.
    pub log_path: Option<String>,
}

/// The device Android-x86's initrd is told to mount at `/data`.
///
/// The data disk is the only virtio block device attached, so it is always `/dev/vda`. Attaching
/// anything else on virtio would shift this and the guest would mount the wrong thing.
pub const DATA_DEVICE: &str = "/dev/vda";

/// The kernel command line handed to Android-x86.
///
/// `SRC=` names the directory holding `system.sfs` as an absolute path from the media root, which
/// is why it is derived from the ISO rather than assumed: an ISO release keeps the payload at the
/// root and an installed layout does not.
///
/// `nomodeset` matters more than it looks: without it the guest tries to bring up KMS against a
/// virtual GPU and can land on a black screen that looks like a hang rather than a graphics
/// failure.
pub fn kernel_command_line(src_dir: &str) -> String {
    [
        "root=/dev/ram0".to_owned(),
        // Android-x86 will not complete boot with SELinux enforcing under QEMU.
        "androidboot.selinux=permissive".to_owned(),
        format!("SRC={src_dir}"),
        format!("DATA={DATA_DEVICE}"),
        "console=ttyS0".to_owned(),
        "nomodeset".to_owned(),
    ]
    .join(" ")
}

pub fn qemu_args(input: &QemuArgsInput) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    let mut push = |items: &[&str]| args.extend(items.iter().map(|s| (*s).to_owned()));

    // Acceleration first: everything else is irrelevant if the guest is interpreting instructions.
    match input.accel {
        // `,kernel-irqchip=off` is required: WHPX does not implement the in-kernel interrupt
        // controller, and QEMU fails to start rather than falling back.
        QemuAccel::Whpx => push(&["-accel", "whpx,kernel-irqchip=off", "-cpu", "max,-vmx,-svm"]),
        QemuAccel::Tcg => push(&["-accel", "tcg", "-cpu", "qemu64"]),
    }

    push(&["-smp", &input.cores.to_string(), "-m", &input.ram_mb.to_string()]);

    // Booted directly from the extracted kernel and initrd rather than through the ISO's boot
    // menu. The menu needs someone to press a key, and this has to come up unattended, which is
    // the whole reason the ISO is parsed for these two files instead of simply being handed to
    // QEMU as a bootable disc.
    push(&["-kernel", &input.kernel_path, "-initrd", &input.initrd_path, "-append", &kernel_command_line(&input.src_dir)]);

    // The ISO stays attached: the kernel and initrd came out of it, but `system.sfs` is still read
    // from the media at runtime.
    push(&["-drive", &format!("file={},media=cdrom,readonly=on", input.iso_path)]);
    push(&["-drive", &format!("file={},format=qcow2,if=virtio", input.data_disk_path)]);

    // adb over TCP, forwarded from the host. There is no USB to emulate.
    push(&["-netdev", &format!("user,id=n0,hostfwd=tcp::{}-:5555", input.adb_port), "-device", "virtio-net-pci,netdev=n0"]);

    if input.headless {
        push(&["-display", "none"]);
    } else {
        // SDL gives an ordinary top-level window, which is what the embedding code reparents.
        push(&["-display", "sdl", "-device", "virtio-vga"]);
    }

    if let Some(log_path) = &input.log_path {
        push(&["-serial", &format!("file:{log_path}")]);
    }

    args
}

/// `qemu-img` arguments for the guest's `/data` disk.
pub fn create_data_disk_args(disk_path: &str, size_gb: u32) -> Vec<String> {
    vec!["create".into(), "-f".into(), "qcow2".into(), disk_path.into(), format!("{size_gb}G")]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> QemuArgsInput {
        QemuArgsInput {
            kernel_path: r"C:\oe\kernel".into(),
            initrd_path: r"C:\oe\initrd-oe.img".into(),
            iso_path: r"C:\oe\android.iso".into(),
            data_disk_path: r"C:\oe\data.qcow2".into(),
            src_dir: String::new(),
            cores: 4,
            ram_mb: 3072,
            accel: QemuAccel::Whpx,
            adb_port: 5555,
            headless: false,
            log_path: None,
        }
    }

    fn value_after<'a>(args: &'a [String], flag: &str) -> &'a str {
        &args[args.iter().position(|a| a == flag).unwrap() + 1]
    }

    #[test]
    fn whpx_disables_the_in_kernel_interrupt_controller() {
        assert_eq!(value_after(&qemu_args(&input()), "-accel"), "whpx,kernel-irqchip=off");
    }

    #[test]
    fn without_acceleration_it_says_tcg_explicitly_rather_than_defaulting() {
        let args = qemu_args(&QemuArgsInput { accel: QemuAccel::Tcg, ..input() });
        assert_eq!(value_after(&args, "-accel"), "tcg");
        assert_eq!(value_after(&args, "-cpu"), "qemu64");
    }

    #[test]
    fn the_guest_boots_from_the_extracted_kernel_not_the_iso_boot_menu() {
        let args = qemu_args(&input());
        assert_eq!(value_after(&args, "-kernel"), r"C:\oe\kernel");
        assert_eq!(value_after(&args, "-initrd"), r"C:\oe\initrd-oe.img");
    }

    #[test]
    fn the_iso_stays_attached_because_system_sfs_is_still_read_from_it() {
        assert!(qemu_args(&input()).iter().any(|a| a.contains("android.iso") && a.contains("media=cdrom")));
    }

    #[test]
    fn the_data_disk_is_the_only_virtio_block_device() {
        let args = qemu_args(&input());
        let virtio = args.iter().filter(|a| a.starts_with("file=") && a.contains("if=virtio")).count();
        assert_eq!(virtio, 1, "a second virtio disk would shift the guest to the wrong device");
        assert_eq!(DATA_DEVICE, "/dev/vda");
        assert!(kernel_command_line("").contains("DATA=/dev/vda"));
    }

    #[test]
    fn src_is_empty_for_an_iso_release_and_named_for_an_installed_layout() {
        assert!(kernel_command_line("").contains("SRC= "));
        assert!(kernel_command_line("/android-9.0-r2").contains("SRC=/android-9.0-r2"));
    }

    #[test]
    fn selinux_is_permissive_and_modesetting_is_off() {
        let cmdline = kernel_command_line("");
        assert!(cmdline.contains("androidboot.selinux=permissive"));
        assert!(cmdline.contains("nomodeset"));
    }

    #[test]
    fn adb_is_forwarded_from_the_host_port_to_the_guest() {
        let args = qemu_args(&QemuArgsInput { adb_port: 5599, ..input() });
        assert!(args.iter().any(|a| a == "user,id=n0,hostfwd=tcp::5599-:5555"));
    }

    #[test]
    fn a_windowed_run_gets_a_real_sdl_window_to_embed() {
        assert_eq!(value_after(&qemu_args(&input()), "-display"), "sdl");
        assert_eq!(value_after(&qemu_args(&QemuArgsInput { headless: true, ..input() }), "-display"), "none");
    }

    #[test]
    fn a_serial_log_is_attached_only_when_asked_for() {
        assert!(!qemu_args(&input()).iter().any(|a| a == "-serial"));
        let args = qemu_args(&QemuArgsInput { log_path: Some(r"C:\oe\qemu.log".into()), ..input() });
        assert_eq!(value_after(&args, "-serial"), r"file:C:\oe\qemu.log");
    }

    #[test]
    fn cores_and_memory_are_passed_through() {
        let args = qemu_args(&QemuArgsInput { cores: 8, ram_mb: 4096, ..input() });
        assert_eq!(value_after(&args, "-smp"), "8");
        assert_eq!(value_after(&args, "-m"), "4096");
    }

    #[test]
    fn the_data_disk_is_created_as_qcow2_at_the_requested_size() {
        assert_eq!(create_data_disk_args(r"C:\oe\data.qcow2", 8), vec!["create", "-f", "qcow2", r"C:\oe\data.qcow2", "8G"]);
    }
}
