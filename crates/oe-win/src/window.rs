//! Reparents a foreign top-level window into ours.
//!
//! Both runtimes produce an ordinary Win32 window — `emulator.exe` paints a Qt one, QEMU an SDL one
//! — so one mechanism serves both. Embedding it beats streaming frames on every axis that matters:
//! the guest renders on the real GPU, and mouse, keyboard, and scroll go straight to the emulator
//! instead of paying an adb round trip per gesture.
//!
//! **The airspace rule.** A child HWND paints over its parent: it is a separate surface, not part
//! of the parent's drawing. Nothing the UI draws can appear on top of it, so anything that would
//! overlap the device must instead hide the embedded window while it is up. The whole UI is laid
//! out around this, which is why the rails sit beside the viewport rather than over it.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, SetLastError, HWND, INVALID_HANDLE_VALUE, LPARAM, POINT, RECT};
use windows_sys::Win32::Graphics::Gdi::ScreenToClient;
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClientRect, GetWindow, GetWindowLongPtrW, GetWindowRect, GetWindowThreadProcessId, IsWindow,
    IsWindowVisible, SetParent, SetWindowLongPtrW, SetWindowPos, ShowWindow, GWL_EXSTYLE, GWL_STYLE, GW_OWNER,
    SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SWP_SHOWWINDOW, SW_HIDE, SW_SHOW,
    WS_CAPTION, WS_CHILD, WS_CLIPCHILDREN, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW, WS_POPUP, WS_SYSMENU, WS_THICKFRAME,
};

use crate::{Hwnd, Rect, WindowStyles};

fn raw(hwnd: Hwnd) -> HWND {
    hwnd.0 as HWND
}

fn from_raw(hwnd: HWND) -> Hwnd {
    Hwnd(hwnd as isize)
}

/// Every pid descended from `root_pid`, including it.
///
/// Walking the process tree, because the window is usually not owned by the process we spawned.
/// `emulator.exe` is a launcher: it starts a separate `qemu-system-x86_64` process and that is
/// what paints the guest. Searching only the pid we launched finds nothing at all.
pub fn descendant_pids(root_pid: u32) -> HashSet<u32> {
    let mut pids = HashSet::from([root_pid]);

    // SAFETY: plain Toolhelp calls; the entry is sized as the API requires and the snapshot is
    // closed on every path.
    let parents = unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot.is_null() || snapshot == INVALID_HANDLE_VALUE {
            return pids;
        }
        let mut parents = HashMap::new();
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if Process32FirstW(snapshot, &mut entry) != 0 {
            loop {
                parents.insert(entry.th32ProcessID, entry.th32ParentProcessID);
                if Process32NextW(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snapshot);
        parents
    };

    // Repeat until nothing new is added: children can appear before their parents in the
    // snapshot, so a single pass would miss a grandchild whose parent came later in the list.
    let mut grew = true;
    while grew {
        grew = false;
        for (&pid, &parent) in &parents {
            if !pids.contains(&pid) && pids.contains(&parent) {
                pids.insert(pid);
                grew = true;
            }
        }
    }
    pids
}

struct FindContext<'a> {
    pids: &'a HashSet<u32>,
    found: HWND,
}

unsafe extern "system" fn find_main_window_proc(hwnd: HWND, lparam: LPARAM) -> i32 {
    // SAFETY: `lparam` is the `FindContext` `find_main_window_for_pids` passed, alive for the
    // whole of `EnumWindows`.
    let context = unsafe { &mut *(lparam as *mut FindContext) };
    let mut pid = 0u32;
    unsafe {
        GetWindowThreadProcessId(hwnd, &mut pid);
        if !context.pids.contains(&pid) || IsWindowVisible(hwnd) == 0 {
            return 1;
        }
        // An owned window is a dialog or a palette belonging to a real one, not the real one.
        if !GetWindow(hwnd, GW_OWNER).is_null() {
            return 1;
        }
        if GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32 & WS_EX_TOOLWINDOW != 0 {
            return 1;
        }
    }
    context.found = hwnd;
    0 // stop enumerating
}

/// The main top-level window belonging to any of `pids`.
///
/// Matched on process id, never on window class. The emulator's Qt class name carries its Qt
/// version (`Qt5152QWindowIcon` and friends), so matching it would break on an SDK update — and
/// QEMU's SDL window has a different one again.
///
/// A process can own several windows: splash screens, tool windows, and the emulator's own
/// extended controls panel. The one wanted is visible, has no owner, and is not marked as a tool
/// window — which is the same test the shell uses to decide what belongs on the taskbar.
pub fn find_main_window_for_pids(pids: &HashSet<u32>) -> Option<Hwnd> {
    let mut context = FindContext { pids, found: std::ptr::null_mut() };
    // SAFETY: the callback only touches the context, which outlives the call.
    unsafe {
        EnumWindows(Some(find_main_window_proc), &mut context as *mut FindContext as LPARAM);
    }
    (!context.found.is_null()).then(|| from_raw(context.found))
}

/// The main window of a process or of anything it started — see [`descendant_pids`].
pub fn find_main_window_for_process_tree(root_pid: u32) -> Option<Hwnd> {
    find_main_window_for_pids(&descendant_pids(root_pid))
}

/// Polls for the window, since a process exists well before it has painted anything.
///
/// Blocking; the UI polls with [`find_main_window_for_process_tree`] on a timer instead. The poll
/// is tight on purpose: between the emulator showing its window and `SetParent` taking it, the
/// window is a separate top-level one on the user's desktop, and the poll interval is the ceiling
/// on how long that flash lasts. Enumerating windows costs well under a millisecond.
pub fn wait_for_window(pid: u32, timeout: Duration, poll: Duration) -> Option<Hwnd> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Some(hwnd) = find_main_window_for_process_tree(pid) {
            return Some(hwnd);
        }
        std::thread::sleep(poll);
    }
    None
}

/// Makes sure the parent clips its children out of its own painting, so its renderer never draws
/// over the embedded window.
pub fn clip_children(parent: Hwnd) {
    // SAFETY: style read-modify-write on a window handle; harmless on a dead handle.
    unsafe {
        let style = GetWindowLongPtrW(raw(parent), GWL_STYLE);
        if style as u32 & WS_CLIPCHILDREN == 0 {
            SetWindowLongPtrW(raw(parent), GWL_STYLE, style | WS_CLIPCHILDREN as isize);
        }
    }
}

/// Turns a top-level window into a child of `parent`.
///
/// The style rewrite is not cosmetic. `SetParent` alone leaves the window with its caption, resize
/// frame, and popup style, so it renders as a floating window pinned inside another one — complete
/// with a title bar the user can drag it out by. Clearing those and adding `WS_CHILD` is what makes
/// it behave as part of the host window. `SWP_FRAMECHANGED` is required for the new styles to be
/// recalculated; without it the old frame is still drawn until something else forces a non-client
/// repaint.
pub fn embed_window(child: Hwnd, parent: Hwnd, bounds: Rect) -> Result<(), String> {
    if !is_live_window(child) {
        return Err("the guest window is gone".into());
    }
    if parent.is_null() {
        return Err("the host window has no native handle yet".into());
    }
    // SAFETY: plain user32 calls on window handles; every result is checked.
    unsafe {
        let style = GetWindowLongPtrW(raw(child), GWL_STYLE) as u32;
        let stripped = (style & !(WS_POPUP | WS_CAPTION | WS_THICKFRAME | WS_SYSMENU)) | WS_CHILD;
        SetWindowLongPtrW(raw(child), GWL_STYLE, stripped as isize);

        let ex_style = GetWindowLongPtrW(raw(child), GWL_EXSTYLE) as u32;
        SetWindowLongPtrW(raw(child), GWL_EXSTYLE, (ex_style & !WS_EX_APPWINDOW) as isize);

        clip_children(parent);

        // `SetParent` returns the window's *previous* parent, and a top-level window has none — so
        // it returns NULL on success. The documented way to tell the two apart is to clear the
        // last error first and read it back: NULL with no error is success.
        SetLastError(0);
        let previous = SetParent(raw(child), raw(parent));
        if previous.is_null() {
            let code = GetLastError();
            if code != 0 {
                return Err(format!("SetParent failed (Win32 error {code})"));
            }
        }
    }
    if !move_window(child, bounds) {
        // SAFETY: reads the thread's last error.
        return Err(format!("SetWindowPos failed (Win32 error {})", unsafe { GetLastError() }));
    }
    Ok(())
}

/// Repositions the embedded window. Called whenever the pane it lives in resizes.
pub fn move_window(child: Hwnd, bounds: Rect) -> bool {
    if !is_live_window(child) {
        return false;
    }
    // SAFETY: plain user32 call on a window handle.
    unsafe {
        SetWindowPos(
            raw(child),
            std::ptr::null_mut(),
            bounds.x,
            bounds.y,
            bounds.width,
            bounds.height,
            // NOACTIVATE matters: without it every resize steals focus from whatever the user was
            // typing into, which makes the search box unusable while the device is visible.
            SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED | SWP_SHOWWINDOW,
        ) != 0
    }
}

/// Reads the styles [`embed_window`] is about to overwrite.
pub fn capture_window_styles(child: Hwnd) -> Option<WindowStyles> {
    if !is_live_window(child) {
        return None;
    }
    // SAFETY: style reads on a live window handle.
    unsafe {
        Some(WindowStyles {
            style: GetWindowLongPtrW(raw(child), GWL_STYLE),
            ex_style: GetWindowLongPtrW(raw(child), GWL_EXSTYLE),
        })
    }
}

/// Gives the window back to the desktop.
///
/// **This is not optional cleanup.** Windows destroys child windows along with their parent, so
/// an embedded guest window that is still a child when our window closes is destroyed with it —
/// while the emulator process carries on running, now with no screen. Every later start then finds
/// no window to embed. So this must run before our window goes away — on quit as well as on a
/// normal stop.
pub fn release_window(child: Hwnd, styles: Option<WindowStyles>) -> bool {
    if !is_live_window(child) {
        return false;
    }
    // SAFETY: plain user32 calls on a live window handle.
    unsafe {
        // Parent first: the window has to stop being a child before WS_CHILD is cleared, or
        // Windows is briefly asked to treat a parented window as top-level.
        SetLastError(0);
        SetParent(raw(child), std::ptr::null_mut());
        if GetLastError() != 0 {
            return false;
        }
        if let Some(styles) = styles {
            SetWindowLongPtrW(raw(child), GWL_STYLE, styles.style);
            SetWindowLongPtrW(raw(child), GWL_EXSTYLE, styles.ex_style);
        }
        // FRAMECHANGED so the restored caption and resize frame are actually recalculated.
        SetWindowPos(
            raw(child),
            std::ptr::null_mut(),
            0,
            0,
            0,
            0,
            SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_FRAMECHANGED,
        ) != 0
    }
}

/// Hides or shows the embedded window — the airspace escape hatch.
pub fn set_window_visible(child: Hwnd, visible: bool) -> bool {
    if !is_live_window(child) {
        return false;
    }
    // ShowWindow's return value is the window's *previous* visibility, not whether the call
    // succeeded, so it is discarded: reaching a live window is the success condition here.
    // SAFETY: plain user32 call on a live window handle.
    unsafe {
        ShowWindow(raw(child), if visible { SW_SHOW } else { SW_HIDE });
    }
    true
}

/// Whether the handle still refers to a live window — the emulator may have exited.
pub fn is_live_window(child: Hwnd) -> bool {
    // SAFETY: IsWindow accepts any value, including stale and null handles.
    !child.is_null() && unsafe { IsWindow(raw(child)) } != 0
}

/// Where the embedded window actually is, in the parent's client coordinates.
///
/// Exists because the emulator moves itself. When the guest's display geometry changes, the
/// emulator's Qt window resizes to its own preferred size for the new display — after our
/// `SetWindowPos`, and without asking. Comparing this against the rectangle we asked for is how
/// the controller notices and puts it back.
pub fn child_bounds(child: Hwnd, parent: Hwnd) -> Option<Rect> {
    if !is_live_window(child) || parent.is_null() {
        return None;
    }
    // SAFETY: plain user32 calls writing into locals.
    unsafe {
        let mut rect: RECT = std::mem::zeroed();
        if GetWindowRect(raw(child), &mut rect) == 0 {
            return None;
        }
        let mut origin = POINT { x: rect.left, y: rect.top };
        if ScreenToClient(raw(parent), &mut origin) == 0 {
            return None;
        }
        Some(Rect::new(origin.x, origin.y, rect.right - rect.left, rect.bottom - rect.top))
    }
}

struct OwnedContext {
    owner: HWND,
    hidden: u32,
}

unsafe extern "system" fn hide_owned_proc(hwnd: HWND, lparam: LPARAM) -> i32 {
    // SAFETY: `lparam` is the `OwnedContext` `hide_owned_windows` passed, alive for the whole call.
    let context = unsafe { &mut *(lparam as *mut OwnedContext) };
    unsafe {
        if GetWindow(hwnd, GW_OWNER) == context.owner && IsWindowVisible(hwnd) != 0 {
            ShowWindow(hwnd, SW_HIDE);
            context.hidden += 1;
        }
    }
    1
}

/// Hides the top-level windows the embedded one owns — the emulator's floating toolbar.
///
/// The emulator's Qt main window owns a separate frameless tool window (Back/Home/Volume/…) docked
/// to its right edge. Owned windows are not children, so `SetParent` leaves it behind as a strip
/// floating over whatever is under it. Every one of its functions is already on our bezel, and it
/// reappears whenever the emulator repositions, so this is called on a timer rather than once.
pub fn hide_owned_windows(child: Hwnd) -> u32 {
    if !is_live_window(child) {
        return 0;
    }
    let mut context = OwnedContext { owner: raw(child), hidden: 0 };
    // SAFETY: the callback only touches the context, which outlives the call.
    unsafe {
        EnumWindows(Some(hide_owned_proc), &mut context as *mut OwnedContext as LPARAM);
    }
    context.hidden
}

/// The window's own client size, for sizing the pane to the guest's aspect ratio.
pub fn client_size(child: Hwnd) -> Option<(i32, i32)> {
    if !is_live_window(child) {
        return None;
    }
    // SAFETY: plain user32 call writing into a local.
    unsafe {
        let mut rect: RECT = std::mem::zeroed();
        if GetClientRect(raw(child), &mut rect) == 0 {
            return None;
        }
        Some((rect.right - rect.left, rect.bottom - rect.top))
    }
}

/// The live Win32 implementation of the controller's window operations.
#[derive(Debug, Clone, Copy, Default)]
pub struct Win32Embed;

impl crate::guest_window::EmbedApi for Win32Embed {
    fn embed_window(&self, child: Hwnd, parent: Hwnd, bounds: Rect) -> Result<(), String> {
        embed_window(child, parent, bounds)
    }

    fn move_window(&self, child: Hwnd, bounds: Rect) -> bool {
        move_window(child, bounds)
    }

    fn set_window_visible(&self, child: Hwnd, visible: bool) -> bool {
        set_window_visible(child, visible)
    }

    fn is_live_window(&self, child: Hwnd) -> bool {
        is_live_window(child)
    }

    fn capture_window_styles(&self, child: Hwnd) -> Option<WindowStyles> {
        capture_window_styles(child)
    }

    fn release_window(&self, child: Hwnd, styles: Option<WindowStyles>) -> bool {
        release_window(child, styles)
    }

    fn child_bounds(&self, child: Hwnd, parent: Hwnd) -> Option<Rect> {
        child_bounds(child, parent)
    }

    fn client_size(&self, child: Hwnd) -> Option<(i32, i32)> {
        client_size(child)
    }

    fn hide_owned_windows(&self, child: Hwnd) -> u32 {
        hide_owned_windows(child)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_process_tree_always_contains_its_own_root() {
        assert!(descendant_pids(std::process::id()).contains(&std::process::id()));
    }

    #[test]
    fn a_child_process_is_found_in_the_tree() {
        // The whole reason the tree search exists: emulator.exe is a launcher that spawns a
        // separate qemu process, and the guest window belongs to that child.
        let mut child = std::process::Command::new("cmd").args(["/c", "ping -n 6 127.0.0.1 >NUL"]).spawn().unwrap();
        std::thread::sleep(Duration::from_millis(300));
        let pids = descendant_pids(std::process::id());
        let found = pids.contains(&child.id());
        let _ = child.kill();
        assert!(found, "child {} missing from the tree", child.id());
    }

    #[test]
    fn a_pid_that_does_not_exist_yields_just_itself() {
        assert_eq!(descendant_pids(999_999), HashSet::from([999_999]));
    }

    #[test]
    fn no_window_is_found_for_a_pid_that_owns_none() {
        assert_eq!(find_main_window_for_process_tree(999_999), None);
    }

    #[test]
    fn waiting_for_a_window_that_never_appears_times_out_rather_than_hanging() {
        let started = Instant::now();
        assert_eq!(wait_for_window(999_999, Duration::from_millis(400), Duration::from_millis(100)), None);
        assert!(started.elapsed() < Duration::from_secs(5), "returned promptly");
    }

    #[test]
    fn operations_on_a_null_handle_fail_closed_instead_of_crashing() {
        let null = Hwnd(0);
        assert!(!is_live_window(null));
        assert!(!move_window(null, Rect::new(0, 0, 10, 10)));
        assert!(!set_window_visible(null, true));
        assert_eq!(client_size(null), None);
        assert!(embed_window(null, Hwnd(1), Rect::default()).is_err());
    }
}
