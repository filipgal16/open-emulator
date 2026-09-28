<#
.SYNOPSIS
  Paired head-to-head: alternates LDPlayer and open-emulator, one trial each, per round.

.DESCRIPTION
  This host throttles under sustained load — identical configs have measured up to 2x apart across
  a session, and trials drift upward within a single run. Any comparison of numbers taken minutes
  apart is therefore unreliable.

  Alternating the two emulators means both see the same thermal state in each round, so the
  per-round difference is meaningful even when absolute values drift. Report the median of the
  per-round ratios, not the ratio of the medians.

  Both sides are timed to the same two events — the definitions bench.sh and bench_ldplayer.ps1
  already share:
    boot    sys.boot_completed == 1 AND `pm path android` answers
    usable  the launcher window has focus (dumpsys window mCurrentFocus)

  LDPlayer used to be timed to its own `list2` "android started" flag instead, which is a different
  event from open-emulator's boot_completed, so the ratio compared two unrelated things.

  What each clock starts from cannot be made fully symmetric, so it is reported rather than hidden:
    LDPlayer       `ldconsole launch`, from Windows. Includes its own window coming up — LDPlayer
                   has no headless mode.
    open-emulator  `open-emu start` inside the distro, which is where bench.sh starts its clock.
                   The wsl.exe hop the desktop app pays before that is measured on its own each
                   round and printed as `+wsl`; add it for a Windows-side figure.

  Each emulator is shut down (untimed) after its trial, so neither is measured while the other is
  still running. bench.sh leaves its guest running when it finishes, which used to put a live
  Android VM under every LDPlayer trial after the first.

.EXAMPLE
  pwsh android/scripts/bench_paired.ps1 -Rounds 3 -Mode cold
#>
[CmdletBinding()]
param(
  [int]$Rounds = 3,
  [ValidateSet('cold', 'snapshot')][string]$Mode = 'cold',
  [string]$Profile = 'fast',
  # The desktop app's defaults and overrides (src/main/index.ts), so this finds the same checkout.
  [string]$Distro = $(if ($env:OPEN_EMULATOR_WSL_DISTRO) { $env:OPEN_EMULATOR_WSL_DISTRO } else { 'OpenEmulator' }),
  [string]$RemotePath = $(if ($env:OPEN_EMULATOR_REMOTE_PATH) { $env:OPEN_EMULATOR_REMOTE_PATH } else { '~/open-emulator' }),
  [string]$LdPath = 'C:\LDPlayer\LDPlayer9',
  [int]$TimeoutSec = 300
)

$ErrorActionPreference = 'SilentlyContinue'
$ld  = Join-Path $LdPath 'ldconsole.exe'
$adb = Join-Path $LdPath 'adb.exe'
# LDPlayer's adb listens on 5555 for instance 0.
$serial = '127.0.0.1:5555'
function LdStarted { ((& $ld list2) -split ',')[4] }

function Stop-LDPlayer {
  & $ld quit --index 0 | Out-Null
  $g = 0
  while ((LdStarted) -ne '0' -and $g -lt 60) { Start-Sleep -Seconds 1; $g++ }
}

function Measure-LDPlayer {
  Stop-LDPlayer
  & $adb kill-server 2>&1 | Out-Null
  Start-Sleep -Seconds 5

  $t1 = $null; $t2 = $null
  $sw = [Diagnostics.Stopwatch]::StartNew()
  & $ld launch --index 0 | Out-Null
  while ($sw.Elapsed.TotalSeconds -lt $TimeoutSec) {
    if (-not $t1) {
      & $adb connect $serial 2>&1 | Out-Null
      $boot = (& $adb -s $serial shell getprop sys.boot_completed 2>$null | Out-String).Trim()
      if ($boot -eq '1') {
        & $adb -s $serial shell pm path android 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) { $t1 = [math]::Round($sw.Elapsed.TotalSeconds, 2) }
      }
    }
    else {
      $focus = & $adb -s $serial shell dumpsys window 2>$null | Select-String 'mCurrentFocus' | Select-Object -First 1
      if ($focus -and ("$focus" -notmatch 'null')) {
        $t2 = [math]::Round($sw.Elapsed.TotalSeconds, 2)
        break
      }
    }
    Start-Sleep -Milliseconds 250
  }
  $sw.Stop()
  return [pscustomobject]@{ t1 = $t1; t2 = $t2 }
}

# `$HOME` is empty in the shell wsl.exe starts, so `~` is resolved from the passwd database — the
# same thing the desktop app does (src/main/wsl/bridge.ts). The result deliberately contains no
# double quotes: Windows PowerShell does not escape them when passing arguments to wsl.exe.
function ConvertTo-BashPath([string]$p) {
  $userHome = '$(getent passwd $(id -u) | cut -d: -f6)'
  if ($p -eq '~') { return $userHome }
  if ($p.StartsWith('~/')) { return $userHome + "/'" + $p.Substring(2) + "'" }
  return "'" + $p + "'"
}

function Invoke-Distro([string]$command) {
  # `-e`, not `--`: with `--`, wsl.exe substitutes `$VAR` itself before bash ever runs, which would
  # empty the path lookup above. See WslBridge.exec for the same trap.
  wsl.exe -d $Distro -e bash -lc $command
}

$checkout = "cd $(ConvertTo-BashPath $RemotePath)"

function Stop-OpenEmu {
  Invoke-Distro "$checkout && ANDROID_PROFILE=$Profile ./android/bin/open-emu stop" | Out-Null
}

function Measure-OpenEmu {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  Invoke-Distro 'true' | Out-Null
  $wsl = [math]::Round($sw.Elapsed.TotalSeconds, 2)

  # One trial through the same bench.sh used everywhere else, so the metric definition matches.
  $cmd = "$checkout && export ANDROID_PROFILE=$Profile ANDROID_HEADLESS=1 && " +
         "./android/scripts/bench.sh --mode $Mode --trials 1 --label paired-$Mode --timeout $TimeoutSec 2>&1"
  $out = (Invoke-Distro $cmd) -join "`n"
  $t1 = if ($out -match 'boot=([0-9.]+)s') { [double]$Matches[1] } else { $null }
  $t2 = if ($out -match 'usable=([0-9.]+)s') { [double]$Matches[1] } else { $null }
  return [pscustomobject]@{ t1 = $t1; t2 = $t2; wsl = $wsl }
}

function Ratio($a, $b) { if ($a -and $b) { [math]::Round($a / $b, 2) } else { $null } }

Write-Host "Paired benchmark - $Rounds round(s), mode=$Mode, profile=$Profile, distro=$Distro"
Write-Host "(alternating so host throttling affects both equally)"
Write-Host ''

Stop-OpenEmu
$rows = @()
for ($r = 1; $r -le $Rounds; $r++) {
  $ldT = Measure-LDPlayer
  Stop-LDPlayer
  Start-Sleep -Seconds 5
  $oeT = Measure-OpenEmu
  Stop-OpenEmu
  Start-Sleep -Seconds 5

  $row = [pscustomobject]@{
    ld1 = $ldT.t1; ld2 = $ldT.t2; oe1 = $oeT.t1; oe2 = $oeT.t2; wsl = $oeT.wsl
    ratio1 = Ratio $ldT.t1 $oeT.t1; ratio2 = Ratio $ldT.t2 $oeT.t2
  }
  Write-Host ("round {0}: boot   LDPlayer={1,6}s  open-emulator={2,6}s (+wsl {3}s)  ratio={4}x" -f `
              $r, $row.ld1, $row.oe1, $row.wsl, $row.ratio1)
  Write-Host ("         usable LDPlayer={0,6}s  open-emulator={1,6}s              ratio={2}x" -f `
              $row.ld2, $row.oe2, $row.ratio2)
  $rows += $row
}

function Median($v) {
  $s = @($v | Where-Object { $_ -ne $null } | Sort-Object)
  if ($s.Count -eq 0) { return $null }
  return $s[[math]::Floor($s.Count / 2)]
}

Write-Host ''
Write-Host ("median boot:   LDPlayer {0}s, open-emulator {1}s (+wsl {2}s)" -f `
            (Median $rows.ld1), (Median $rows.oe1), (Median $rows.wsl))
Write-Host ("median usable: LDPlayer {0}s, open-emulator {1}s" -f (Median $rows.ld2), (Median $rows.oe2))
Write-Host ("median ratio:  boot {0}x, usable {1}x  (>1 means open-emulator is faster)" -f `
            (Median $rows.ratio1), (Median $rows.ratio2))
