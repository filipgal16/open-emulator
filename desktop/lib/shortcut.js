const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const paths = require("./paths");

const DEV_LAUNCHER = path.join(paths.DESKTOP_ROOT, "bin", "open-emulator");

function launcherExec() {
  return paths.launcherExec(DEV_LAUNCHER);
}

function iconPath() {
  return path.join(paths.brandRoot(), "logo", "app-icon.svg");
}

function desktopEntry() {
  return `[Desktop Entry]
Type=Application
Name=open-emulator
Comment=Mint Android emulator — start isolated machines
Exec=${quoteExec(launcherExec())}
Icon=${iconPath()}
Terminal=false
Categories=Development;Emulator;
StartupWMClass=open-emulator
`;
}

function quoteExec(value) {
  // .desktop Exec= values are shell-ish; quote so paths with spaces survive.
  return /\s/.test(value) ? `"${value}"` : value;
}

async function writeDesktopFile(target) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, desktopEntry(), { mode: 0o644 });
  try {
    await fsp.chmod(target, 0o755);
  } catch {
    /* ignore */
  }
  return target;
}

async function installShortcut(options = {}) {
  const home = os.homedir();
  const applications = path.join(home, ".local", "share", "applications", "open-emulator.desktop");
  const written = [await writeDesktopFile(applications)];
  if (options.desktop !== false) {
    const desktopDir = path.join(home, "Desktop");
    try {
      await fsp.access(desktopDir);
      written.push(await writeDesktopFile(path.join(desktopDir, "open-emulator.desktop")));
    } catch {
      /* no Desktop folder */
    }
  }
  return { ok: true, files: written };
}

function shortcutInstalled() {
  const home = os.homedir();
  return fs.existsSync(path.join(home, ".local", "share", "applications", "open-emulator.desktop"));
}

module.exports = { installShortcut, shortcutInstalled, launcherExec, iconPath };
