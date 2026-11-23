//! Embeds the app icon and version details into `open-emulator.exe`, so Explorer, the taskbar and
//! the installer's shortcuts show the mark rather than a blank program icon.

fn main() {
    println!("cargo:rerun-if-changed=assets/icon.ico");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    #[cfg(windows)]
    {
        let mut resource = winresource::WindowsResource::new();
        resource
            .set_icon("assets/icon.ico")
            .set("ProductName", "open-emulator")
            .set("FileDescription", "open-emulator")
            .set("CompanyName", "open-emulator contributors")
            .set("LegalCopyright", "open-emulator contributors");
        // A machine without the Windows SDK's resource compiler still builds the app, just
        // without the icon in Explorer; the window sets its own icon at run time either way.
        if let Err(error) = resource.compile() {
            println!("cargo:warning=open-emulator.exe has no embedded icon: {error}");
        }
    }
}
