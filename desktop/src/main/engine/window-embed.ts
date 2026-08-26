import koffi from 'koffi';

/**
 * Reparents a foreign top-level window into the Electron window.
 *
 * Both runtimes produce an ordinary Win32 window — `emulator.exe` paints a Qt one, QEMU an SDL one
 * — so one mechanism serves both. Embedding it beats streaming frames on every axis that matters:
 * the guest renders on the real GPU, and mouse, keyboard, and scroll go straight to the emulator
 * instead of paying an `adb shell input` round trip per gesture.
 *
 * Done through FFI rather than a native addon deliberately. `koffi` ships prebuilt binaries, so
 * there is no node-gyp, no MSVC, and no `electron-rebuild` step in the build — which for one
 * `SetParent` call is the right trade.
 *
 * **The airspace rule.** A child HWND paints over the page: it is a separate surface, not part of
 * the document. Nothing in HTML can be drawn on top of it, so any modal, dropdown, or toast that
 * would overlap the device must instead hide the embedded window while it is up. The whole UI is
 * laid out around this, which is why the rails sit beside the viewport rather than over it.
 */

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');

/**
 * Walking the process tree, because the window is usually not owned by the process we spawned.
 *
 * `emulator.exe` is a launcher: it starts a separate `qemu-system-x86_64` process and that is what
 * paints the guest. Searching only the pid we launched finds nothing at all — verified against
 * Windows' own Notepad, which behaves identically (`notepad.exe` hands off to a Store-app process
 * and the window belongs to the child).
 *
 * Done through Toolhelp rather than by shelling out to PowerShell for `Win32_Process`, because this
 * runs on a poll while waiting for the window to appear, and a PowerShell round trip per attempt
 * would cost more than the wait itself.
 */
const PROCESSENTRY32 = koffi.struct('PROCESSENTRY32', {
  dwSize: 'uint32',
  cntUsage: 'uint32',
  th32ProcessID: 'uint32',
  th32DefaultHeapID: 'uintptr',
  th32ModuleID: 'uint32',
  cntThreads: 'uint32',
  th32ParentProcessID: 'uint32',
  pcPriClassBase: 'int32',
  dwFlags: 'uint32',
  szExeFile: koffi.array('char', 260),
});

const TH32CS_SNAPPROCESS = 0x0000_0002;
const INVALID_HANDLE = -1;

const CreateToolhelp32Snapshot = kernel32.func('void* CreateToolhelp32Snapshot(uint32 dwFlags, uint32 th32ProcessID)');
const Process32First = kernel32.func('bool Process32First(void* hSnapshot, _Inout_ PROCESSENTRY32* lppe)');
const Process32Next = kernel32.func('bool Process32Next(void* hSnapshot, _Inout_ PROCESSENTRY32* lppe)');
const CloseHandle = kernel32.func('bool CloseHandle(void* hObject)');
// Needed because several of these APIs signal success with a zero return value — see `embedWindow`.
const GetLastError = kernel32.func('uint32 GetLastError()');
const SetLastError = kernel32.func('void SetLastError(uint32 dwErrCode)');

/** Every pid descended from `rootPid`, including it. */
export function descendantPids(rootPid: number): Set<number> {
  const pids = new Set<number>([rootPid]);

  const snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (!snapshot || koffi.address(snapshot) === BigInt(INVALID_HANDLE)) return pids;

  try {
    const parents = new Map<number, number>();
    const entry = { dwSize: koffi.sizeof(PROCESSENTRY32) } as Record<string, unknown>;

    if (Process32First(snapshot, entry)) {
      do {
        parents.set(entry.th32ProcessID as number, entry.th32ParentProcessID as number);
      } while (Process32Next(snapshot, entry));
    }

    // Repeat until nothing new is added: children can appear before their parents in the snapshot,
    // so a single pass would miss a grandchild whose parent came later in the list.
    let grew = true;
    while (grew) {
      grew = false;
      for (const [pid, parent] of parents) {
        if (!pids.has(pid) && pids.has(parent)) {
          pids.add(pid);
          grew = true;
        }
      }
    }
  } finally {
    CloseHandle(snapshot);
  }

  return pids;
}

// koffi needs the layout of anything passed by pointer.
const RECT = koffi.struct('RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });

const EnumWindowsProc = koffi.proto('bool EnumWindowsProc(void* hwnd, void* lParam)');

const GetWindowThreadProcessId = user32.func('uint32 GetWindowThreadProcessId(void* hWnd, _Out_ uint32* lpdwProcessId)');
const EnumWindows = user32.func('bool EnumWindows(EnumWindowsProc* lpEnumFunc, void* lParam)');
const IsWindowVisible = user32.func('bool IsWindowVisible(void* hWnd)');
const GetWindow = user32.func('void* GetWindow(void* hWnd, uint32 uCmd)');
// Declared with the parent as a plain `uintptr` rather than `void*`, because the parent does not
// arrive as a pointer — Electron hands the HWND over as a *buffer containing* the handle value.
// Passing that buffer as `void*` sends the address of the buffer instead of the handle inside it,
// which Windows rejects with ERROR_INVALID_WINDOW_HANDLE. See `readHandle`.
const SetParent = user32.func('SetParent', 'uintptr', ['void*', 'uintptr']);
const SetWindowLongPtrW = user32.func('intptr SetWindowLongPtrW(void* hWnd, int32 nIndex, intptr dwNewLong)');
const GetWindowLongPtrW = user32.func('intptr GetWindowLongPtrW(void* hWnd, int32 nIndex)');
const SetWindowPos = user32.func(
  'bool SetWindowPos(void* hWnd, void* hWndInsertAfter, int32 X, int32 Y, int32 cx, int32 cy, uint32 uFlags)',
);
const ShowWindow = user32.func('bool ShowWindow(void* hWnd, int32 nCmdShow)');
const IsWindow = user32.func('bool IsWindow(void* hWnd)');
const GetClientRect = user32.func('bool GetClientRect(void* hWnd, _Out_ RECT* lpRect)');

const GWL_STYLE = -16;
const GWL_EXSTYLE = -20;

const WS_CHILD = 0x4000_0000;
const WS_POPUP = 0x8000_0000;
const WS_CAPTION = 0x00c0_0000;
const WS_THICKFRAME = 0x0004_0000;
const WS_SYSMENU = 0x0008_0000;
const WS_EX_APPWINDOW = 0x0004_0000;
const WS_EX_TOOLWINDOW = 0x0000_0080;

const SW_HIDE = 0;
const SW_SHOW = 5;

const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SWP_FRAMECHANGED = 0x0020;
const SWP_SHOWWINDOW = 0x0040;

const GW_OWNER = 4;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The main top-level window belonging to a process.
 *
 * Matched on process id, never on window class. The emulator's Qt class name carries its Qt
 * version (`Qt5152QWindowIcon` and friends), so matching it would break on an SDK update — and
 * QEMU's SDL window has a different one again.
 *
 * A process can own several windows: splash screens, tool windows, and the emulator's own extended
 * controls panel. The one wanted is visible, has no owner, and is not marked as a tool window —
 * which is the same test the shell uses to decide what belongs on the taskbar.
 */
export function findMainWindowForPid(pid: number): unknown | null {
  return findMainWindowForPids(new Set([pid]));
}

/** As above, but accepting a whole process tree — see `descendantPids`. */
export function findMainWindowForProcessTree(rootPid: number): unknown | null {
  return findMainWindowForPids(descendantPids(rootPid));
}

function findMainWindowForPids(pids: Set<number>): unknown | null {
  let found: unknown = null;

  const callback = koffi.register((hwnd: unknown): boolean => {
    const out = [0];
    GetWindowThreadProcessId(hwnd, out);
    if (!pids.has(out[0])) return true;

    if (!IsWindowVisible(hwnd)) return true;
    // An owned window is a dialog or a palette belonging to a real one, not the real one.
    if (GetWindow(hwnd, GW_OWNER)) return true;
    if (Number(GetWindowLongPtrW(hwnd, GWL_EXSTYLE)) & WS_EX_TOOLWINDOW) return true;

    found = hwnd;
    return false; // stop enumerating
  }, koffi.pointer(EnumWindowsProc));

  try {
    EnumWindows(callback, null);
  } finally {
    koffi.unregister(callback);
  }

  return found;
}

/** Polls for the window, since a process exists well before it has painted anything. */
export async function waitForWindow(pid: number, timeoutMs = 60_000, pollMs = 250): Promise<unknown | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hwnd = findMainWindowForProcessTree(pid);
    if (hwnd) return hwnd;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return null;
}

/**
 * Turns a top-level window into a child of `parent`.
 *
 * The style rewrite is not cosmetic. `SetParent` alone leaves the window with its caption, resize
 * frame, and popup style, so it renders as a floating window pinned inside another one — complete
 * with a title bar the user can drag it out by. Clearing those and adding `WS_CHILD` is what makes
 * it behave as part of the host window.
 *
 * `SWP_FRAMECHANGED` is required for the new styles to be recalculated; without it the old frame
 * is still drawn until something else forces a non-client repaint.
 */
export function embedWindow(child: unknown, parent: Buffer, bounds: Rect): boolean {
  if (!IsWindow(child)) return false;

  const style = Number(GetWindowLongPtrW(child, GWL_STYLE));
  const stripped = (style & ~(WS_POPUP | WS_CAPTION | WS_THICKFRAME | WS_SYSMENU)) | WS_CHILD;
  SetWindowLongPtrW(child, GWL_STYLE, BigInt(stripped >>> 0) as unknown as number);

  const exStyle = Number(GetWindowLongPtrW(child, GWL_EXSTYLE));
  SetWindowLongPtrW(child, GWL_EXSTYLE, BigInt((exStyle & ~WS_EX_APPWINDOW) >>> 0) as unknown as number);

  const parentHandle = readHandle(parent);
  if (parentHandle === 0n) throw new Error('the host window has no native handle yet');

  // `SetParent` returns the window's *previous* parent, and a top-level window has none — so it
  // returns NULL on success. Treating that as a failure is why embedding reported "refused" while
  // very likely having worked. The documented way to tell the two apart is to clear the last error
  // first and read it back: NULL with no error is success.
  SetLastError(0);
  const previousParent = SetParent(child, parentHandle);
  if (!previousParent) {
    const code = GetLastError();
    if (code !== 0) throw new Error(`SetParent failed (Win32 error ${code})`);
  }

  if (!moveWindow(child, bounds)) throw new Error(`SetWindowPos failed (Win32 error ${GetLastError()})`);
  return true;
}

/** Repositions the embedded window. Called whenever the pane it lives in resizes. */
export function moveWindow(child: unknown, bounds: Rect): boolean {
  if (!IsWindow(child)) return false;
  return SetWindowPos(
    child,
    null,
    Math.round(bounds.x),
    Math.round(bounds.y),
    Math.round(bounds.width),
    Math.round(bounds.height),
    // NOACTIVATE matters: without it every resize steals focus from whatever the user was typing
    // into, which makes the search box unusable while the device is visible.
    SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED | SWP_SHOWWINDOW,
  );
}

/** A window's styles, captured before embedding so they can be put back. */
export interface WindowStyles {
  style: number;
  exStyle: number;
}

/** Reads the styles `embedWindow` is about to overwrite. */
export function captureWindowStyles(child: unknown): WindowStyles | null {
  if (!IsWindow(child)) return null;
  return {
    style: Number(GetWindowLongPtrW(child, GWL_STYLE)),
    exStyle: Number(GetWindowLongPtrW(child, GWL_EXSTYLE)),
  };
}

/**
 * Gives the window back to the desktop.
 *
 * **This is not optional cleanup.** Windows destroys child windows along with their parent, so an
 * embedded guest window that is still a child when our window closes is destroyed with it — while
 * the emulator process carries on running, now with no screen. Observed exactly that way: after the
 * app was killed mid-embed, the emulator kept running and rendering, and the only window it had
 * left was its 54x508 floating toolbar. Every later start then found no window to embed.
 *
 * So this must run before our window goes away — on quit as well as on a normal stop.
 */
export function releaseWindow(child: unknown, styles: WindowStyles | null): boolean {
  if (!IsWindow(child)) return false;

  // Parent first: the window has to stop being a child before WS_CHILD is cleared, or Windows is
  // briefly asked to treat a parented window as top-level.
  SetLastError(0);
  SetParent(child, 0n);
  if (GetLastError() !== 0) return false;

  if (styles) {
    SetWindowLongPtrW(child, GWL_STYLE, BigInt(styles.style >>> 0) as unknown as number);
    SetWindowLongPtrW(child, GWL_EXSTYLE, BigInt(styles.exStyle >>> 0) as unknown as number);
  }

  // FRAMECHANGED so the restored caption and resize frame are actually recalculated and drawn.
  return SetWindowPos(child, null, 0, 0, 0, 0, SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_FRAMECHANGED);
}

/**
 * Hides or shows the embedded window.
 *
 * This is the airspace escape hatch, and the reason it exists is worth stating: a child HWND is
 * painted over the page, so an HTML dialog opened above the device would be invisible. Hiding the
 * window while a panel or modal is up is what makes the rest of the UI work at all.
 */
export function setWindowVisible(child: unknown, visible: boolean): boolean {
  if (!IsWindow(child)) return false;
  // ShowWindow's return value is the window's *previous* visibility, not whether the call
  // succeeded — so it reads as a failure every time a hidden window is hidden again. Discarded
  // deliberately; reaching a live window is the success condition here.
  ShowWindow(child, visible ? SW_SHOW : SW_HIDE);
  return true;
}

/** Whether the handle still refers to a live window — the emulator may have exited. */
export function isLiveWindow(child: unknown): boolean {
  return Boolean(child) && Boolean(IsWindow(child));
}

/**
 * The `HWND` value out of the buffer Electron returns from `getNativeWindowHandle()`.
 *
 * The buffer *contains* the handle; it is not a pointer to the window. Handing the buffer itself
 * to a `void*` parameter passes the buffer's own address, which Windows rejects with
 * ERROR_INVALID_WINDOW_HANDLE (1400) — observed against a real emulator window before this existed.
 *
 * Eight bytes on x64, four on x86, little-endian in both cases.
 */
function readHandle(buffer: Buffer): bigint {
  if (buffer.length >= 8) return buffer.readBigUInt64LE(0);
  if (buffer.length >= 4) return BigInt(buffer.readUInt32LE(0));
  return 0n;
}

/** The window's own client size, for sizing the pane to the guest's aspect ratio. */
export function clientSize(child: unknown): { width: number; height: number } | null {
  if (!IsWindow(child)) return null;
  const rect = { left: 0, top: 0, right: 0, bottom: 0 };
  if (!GetClientRect(child, rect)) return null;
  return { width: rect.right - rect.left, height: rect.bottom - rect.top };
}
