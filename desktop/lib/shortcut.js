const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

const DESKTOP_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(DESKTOP_ROOT, "..");
const LAUNCHER = path.join(DESKTOP_ROOT, "bin", "open-emulator");
const ICON = path.join(REPO_ROOT, "brand", "logo", "app-icon.svg");

function desktopEntry() {
  return `[Desktop Entry]
Type=Application
Name=open-emulator
Comment=Mint Android emulator — start isolated machines
Exec=${LAUNCHER}
Icon=${ICON}
Terminal=false
Categories=Development;Emulator;
StartupWMClass=open-emulator
`;
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

module.exports = { installShortcut, shortcutInstalled, LAUNCHER, ICON };
