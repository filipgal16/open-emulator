<#
.SYNOPSIS
  Benchmarks LDPlayer start time using the same metric definition as bench.sh, so the two
  are directly comparable.

.DESCRIPTION
  Measures, per trial, from process launch to:
    t1_boot_s    sys.boot_completed == 1 AND `pm path android` answers
    t2_usable_s  launcher window has focus (dumpsys window mCurrentFocus)

  There is no t3 for LDPlayer: it renders its own window natively, so there is no
  equivalent of open-emulator's adb-screencap mirror hop to measure.

  Appends to the same CSV as bench.sh. Run with LDPlayer fully closed.

.EXAMPLE
  pwsh android/scripts/bench_ldplayer.ps1 -Trials 5
#>
[CmdletBinding()]
param(
  [int]$Trials = 5,
  [string]$Label = 'ldplayer-default',
  [int]$Index = 0,
  [string]$LdPath = 'C:\LDPlayer\LDPlayer9',
  [string]$Csv = "$PSScriptRoot\..\logs\bench.csv",
  [int]$TimeoutSec = 300
)

$ErrorActionPreference = 'Stop'

$console = Join-Path $LdPath 'ldconsole.exe'
$adb     = Join-Path $LdPath 'adb.exe'
foreach ($exe in @($console, $adb)) {
  if (-not (Test-Path $exe)) { throw "Not found: $exe  (use -LdPath to point at your LDPlayer install)" }
}

# LDPlayer's adb listens on a per-instance port: 5555 for index 0, then +2 per instance.
$serial = "127.0.0.1:$(5555 + $Index * 2)"

function Stop-Instance {
  & $console quit --index $Index 2>&1 | Out-Null
  # quit returns immediately; wait for the VM process to actually go away or the next
  # trial starts against a still-shutting-down instance and the timing is meaningless.
  for ($i = 0; $i -lt 60; $i++) {
    $running = & $console runninglist 2>&1
    if (-not ($running -match '\S')) { return }
    Start-Sleep -Milliseconds 500
  }
}

function Get-Prop([string]$prop) {
  $v = & $adb -s $serial shell getprop $prop 2>$null
  if ($LASTEXITCODE -ne 0) { return '' }
  return ($v | Out-String).Trim()
}

Write-Host "LDPlayer benchmark - $Trials trial(s), instance $Index, serial $serial"
Write-Host ''

$results = @()

for ($trial = 1; $trial -le $Trials; $trial++) {
  Write-Host ("trial {0}/{1}: " -f $trial, $Trials) -NoNewline

  Stop-Instance
  & $adb kill-server 2>&1 | Out-Null
  Start-Sleep -Seconds 3

  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  & $console launch --index $Index 2>&1 | Out-Null

  $t1 = $null; $t2 = $null
  $deadline = $sw.Elapsed.TotalSeconds + $TimeoutSec

  while ($sw.Elapsed.TotalSeconds -lt $deadline) {
    if (-not $t1) {
      & $adb connect $serial 2>&1 | Out-Null
      if ((Get-Prop 'sys.boot_completed') -eq '1') {
        & $adb -s $serial shell pm path android 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) { $t1 = [math]::Round($sw.Elapsed.TotalSeconds, 2) }
      }
    }
    else {
      $focus = & $adb -s $serial shell dumpsys window 2>$null | Select-String 'mCurrentFocus'
      if ($focus -and ($focus -notmatch 'null')) {
        $t2 = [math]::Round($sw.Elapsed.TotalSeconds, 2)
        break
      }
    }
    Start-Sleep -Milliseconds 250
  }
  $sw.Stop()

  if ($t1) {
    Write-Host ("boot={0}s usable={1}s" -f $t1, $(if ($t2) { $t2 } else { 'timeout' }))
    $results += [pscustomobject]@{ t1 = $t1; t2 = $t2 }
  } else {
    Write-Host 'TIMEOUT - no boot_completed'
  }

  $stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  $row = '{0},{1},{2},{3},{4},{5},{6}' -f $stamp, $Label, 'ldplayer', $trial,
         $(if ($t1) { $t1 } else { '' }), $(if ($t2) { $t2 } else { '' }), ''
  $dir = Split-Path $Csv -Parent
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
  if (-not (Test-Path $Csv)) {
    Set-Content -Path $Csv -Value 'timestamp,label,mode,trial,t1_boot_s,t2_usable_s,t3_frame_s' -Encoding utf8
  }
  Add-Content -Path $Csv -Value $row -Encoding utf8
}

Stop-Instance

function Median($values) {
  $v = @($values | Where-Object { $_ -ne $null } | Sort-Object)
  if ($v.Count -eq 0) { return $null }
  return $v[[math]::Floor($v.Count / 2)]
}

Write-Host ''
Write-Host ("median boot:   {0}s" -f (Median ($results | ForEach-Object { $_.t1 })))
Write-Host ("median usable: {0}s" -f (Median ($results | ForEach-Object { $_.t2 })))
Write-Host ("appended to {0}" -f $Csv)
