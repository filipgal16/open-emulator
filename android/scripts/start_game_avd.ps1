<#
.SYNOPSIS
  Start a game AVD natively on Windows, the way the desktop app's native engine does.

.DESCRIPTION
  Launches the Android Emulator directly (WHPX + host GPU, OpenGL ES 3.1) and waits for Android.

  Starts are Quick Boot starts: the emulator restores the snapshot it saved when it last
  exited, which measured about 8 s on the openemu-compat image against about 47 s for a cold
  boot. Close the emulator window (or `adb emu kill`) rather than killing the process, so the
  snapshot is saved. -Cold boots from scratch and still saves a snapshot on exit.

  On a stock Google APIs image it then gives ARM apps a /proc/cpuinfo that lists every guest
  core instead of one; without that, Unity games log "Cores = 1" and run with no job worker
  threads and no render thread. That takes `adb root`, so it works on userdebug (google_apis)
  images and not on Play Store ones. The openemu-compat ROM has it built into the image, and
  the step is skipped.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File android\scripts\start_game_avd.ps1
  powershell -ExecutionPolicy Bypass -File android\scripts\start_game_avd.ps1 -Launch com.example.game
  powershell -ExecutionPolicy Bypass -File android\scripts\start_game_avd.ps1 -Cold
#>
param(
  [string]$Avd = 'OpenEmulator_API34_compat',
  # Boot from scratch instead of restoring the Quick Boot snapshot.
  [switch]$Cold,
  # The data root: the same override the desktop app and `npm run rom:build` read.
  [string]$Root = $(if ($env:OPEN_EMULATOR_DOWNLOAD_ROOT) { $env:OPEN_EMULATOR_DOWNLOAD_ROOT } else { Join-Path $env:LOCALAPPDATA 'open-emulator' }),
  [int]$Port = 5554,
  [string]$Launch = '',
  [int]$BootTimeoutSec = 400
)

$ErrorActionPreference = 'Stop'
$emulator = Join-Path $Root 'sdk\emulator\emulator.exe'
$adb = Join-Path $Root 'sdk\platform-tools\adb.exe'
$serial = "emulator-$Port"
$logDir = Join-Path $Root 'logs'
foreach ($p in $emulator, $adb, (Join-Path $Root "avd\$Avd.avd")) {
  if (-not (Test-Path $p)) { throw "missing: $p" }
}
New-Item -ItemType Directory -Force $logDir | Out-Null

$env:ANDROID_SDK_ROOT = Join-Path $Root 'sdk'
$env:ANDROID_HOME = $env:ANDROID_SDK_ROOT
$env:ANDROID_AVD_HOME = Join-Path $Root 'avd'

# Windows PowerShell 5.1 turns a native command's redirected stderr into error records, which
# 'Stop' would make fatal; adb prints to stderr whenever the device is not up yet.
function Invoke-Adb {
  $ErrorActionPreference = 'SilentlyContinue'
  & $adb -s $serial @args 2>$null
}

$running = ("$(Invoke-Adb shell getprop sys.boot_completed)".Trim() -eq '1')
if (-not $running) {
  # Quick Boot only restores a snapshot when the AVD's own config asks for a fast boot; an AVD
  # created with cold-boot settings would ignore the snapshot it saved.
  $configPath = Join-Path $Root "avd\$Avd.avd\config.ini"
  $config = [IO.File]::ReadAllText($configPath)
  $wanted = $config -replace '(?m)^fastboot\.forceColdBoot=.*$', 'fastboot.forceColdBoot=no' `
                    -replace '(?m)^fastboot\.forceFastBoot=.*$', 'fastboot.forceFastBoot=yes'
  if ($wanted -ne $config) { [IO.File]::WriteAllText($configPath, $wanted, (New-Object Text.UTF8Encoding $false)) }

  $emuArgs = @(
    '-avd', $Avd, '-port', "$Port",
    '-gpu', 'host', '-accel', 'on',
    '-feature', 'GLESDynamicVersion',
    '-no-boot-anim', '-no-metrics',
    '-netdelay', 'none', '-netspeed', 'full'
  )
  # No snapshot flag at all is what makes Quick Boot restore `default_boot`; `-snapshot <name>`
  # is silently ignored by this emulator (see avd-config.ts in the desktop app).
  if ($Cold) { $emuArgs += '-no-snapshot-load' }
  $hasSnapshot = Test-Path (Join-Path $Root "avd\$Avd.avd\snapshots\default_boot")
  Write-Host ("starting $Avd ({0}) ..." -f $(if ($Cold -or -not $hasSnapshot) { 'cold boot' } else { 'Quick Boot snapshot' }))
  $t0 = Get-Date
  $proc = Start-Process -FilePath $emulator -ArgumentList $emuArgs -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logDir "$Avd.out.log") `
    -RedirectStandardError (Join-Path $logDir "$Avd.err.log")
  $booted = $false
  while (((Get-Date) - $t0).TotalSeconds -lt $BootTimeoutSec) {
    Start-Sleep -Milliseconds 500
    if ($proc.HasExited) { throw "emulator exited with code $($proc.ExitCode); see $logDir\$Avd.out.log" }
    if ("$(Invoke-Adb shell getprop sys.boot_completed)".Trim() -eq '1') { $booted = $true; break }
  }
  if (-not $booted) { throw "Android did not finish booting within $BootTimeoutSec s" }
  Write-Host ("booted in {0:N1} s" -f ((Get-Date) - $t0).TotalSeconds)
} else {
  Write-Host "$Avd is already running"
}

# --- ARM-translation CPU fix -------------------------------------------------------------
# The openemu-compat ROM carries this in the image; only a stock Google image needs it applied
# at run time, which takes root.
$guestCores = [int]("$(Invoke-Adb shell nproc)".Trim())
$armCores = "$(Invoke-Adb shell 'grep -c ^processor /system/etc/cpuinfo.arm64.txt 2>/dev/null')".Trim()
if ($armCores -eq "$guestCores") {
  Write-Host "ARM apps see all $guestCores CPU cores (built into the image)"
} elseif (-not $armCores) {
  Write-Host 'this image has no ARM translator; nothing to fix'
} else {
  Invoke-Adb root | Out-Null
  Start-Sleep -Seconds 2
  Invoke-Adb wait-for-device | Out-Null
}
if ($armCores -eq "$guestCores" -or -not $armCores) {
  # nothing to do
} elseif ("$(Invoke-Adb shell id -u)".Trim() -ne '0') {
  Write-Warning 'adb root refused (Play Store image?): ARM apps will see a single CPU core.'
} else {
  $cores = [int]("$(Invoke-Adb shell nproc)".Trim())
  $tmp = Join-Path $env:TEMP "open-emu-cpuinfo-$PID"
  New-Item -ItemType Directory -Force $tmp | Out-Null
  $variants = @{
    'cpuinfo.arm64.txt' = 'fp asimd evtstrm aes pmull sha1 sha2 crc32 atomics fphp asimdhp'
    'cpuinfo.arm.txt'   = 'neon vfp swp half thumb fastmult edsp vfpv3 vfpv4 idiva idivt'
  }
  foreach ($name in $variants.Keys) {
    $sb = New-Object System.Text.StringBuilder
    for ($i = 0; $i -lt $cores; $i++) {
      [void]$sb.Append("processor`t: $i`nBogoMIPS`t: 1.00`nFeatures`t: $($variants[$name])`n")
      [void]$sb.Append("CPU implementer`t: 0x41`nCPU architecture: 8`nCPU variant`t: 0x6`nCPU part`t: 0x802`nCPU revision`t: 13`n`n")
    }
    $local = Join-Path $tmp $name
    [IO.File]::WriteAllText($local, $sb.ToString(), (New-Object Text.UTF8Encoding $false))
    $remote = "/data/local/tmp/$name"
    Invoke-Adb push $local $remote | Out-Null
    # Unmount a previous overlay first so re-running the script does not stack mounts.
    Invoke-Adb shell "umount /system/etc/$name 2>/dev/null; chmod 644 $remote && chcon u:object_r:system_file:s0 $remote && mount --bind $remote /system/etc/$name" | Out-Null
  }
  Remove-Item -Recurse -Force $tmp
  $seen = "$(Invoke-Adb shell 'grep -c ^processor /system/etc/cpuinfo.arm64.txt')".Trim()
  Write-Host "ARM apps now see $seen of $cores CPU cores"
}

# Keep the screen on while playing.
Invoke-Adb shell 'settings put system screen_off_timeout 2147483647; svc power stayon true; input keyevent KEYCODE_WAKEUP; wm dismiss-keyguard' | Out-Null

if ($Launch) {
  Invoke-Adb shell "monkey -p $Launch -c android.intent.category.LAUNCHER 1" | Out-Null
  Write-Host "launched $Launch"
}
Write-Host "ready: adb serial $serial"
