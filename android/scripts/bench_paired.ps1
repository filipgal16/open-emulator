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

.EXAMPLE
  pwsh android/scripts/bench_paired.ps1 -Rounds 3 -Mode cold
#>
[CmdletBinding()]
param(
  [int]$Rounds = 3,
  [ValidateSet('cold', 'snapshot')][string]$Mode = 'cold',
  [string]$Profile = 'fast',
  [string]$Distro = 'Ubuntu',
  [string]$LdPath = 'C:\LDPlayer\LDPlayer9'
)

$ErrorActionPreference = 'SilentlyContinue'
$ld = Join-Path $LdPath 'ldconsole.exe'
function LdStarted { ((& $ld list2) -split ',')[4] }

function Measure-LDPlayer {
  & $ld quit --index 0 | Out-Null
  $g = 0
  while ((LdStarted) -ne '0' -and $g -lt 60) { Start-Sleep -Seconds 1; $g++ }
  Start-Sleep -Seconds 5

  $sw = [Diagnostics.Stopwatch]::StartNew()
  & $ld launch --index 0 | Out-Null
  while ($sw.Elapsed.TotalSeconds -lt 180) {
    if ((LdStarted) -eq '1') { $sw.Stop(); return [math]::Round($sw.Elapsed.TotalSeconds, 2) }
    Start-Sleep -Milliseconds 400
  }
  $sw.Stop(); return $null
}

function Measure-OpenEmu {
  # One trial through the same bench.sh used everywhere else, so the metric definition matches.
  $cmd = "cd /root/open-emulator; export ANDROID_PROFILE=$Profile ANDROID_HEADLESS=1; " +
         "./android/scripts/bench.sh --mode $Mode --trials 1 --label paired-$Mode --timeout 300 " +
         "2>&1 | grep -oE 'boot=[0-9.]+' | head -1"
  $out = wsl.exe -d $Distro -- bash -lc $cmd
  if ("$out" -match 'boot=([0-9.]+)') { return [double]$Matches[1] }
  return $null
}

Write-Host "Paired benchmark - $Rounds round(s), mode=$Mode, profile=$Profile"
Write-Host "(alternating so host throttling affects both equally)"
Write-Host ''

$rows = @()
for ($r = 1; $r -le $Rounds; $r++) {
  $ldT = Measure-LDPlayer
  & $ld quit --index 0 | Out-Null
  Start-Sleep -Seconds 5
  $oeT = Measure-OpenEmu

  $ratio = if ($ldT -and $oeT) { [math]::Round($ldT / $oeT, 2) } else { $null }
  Write-Host ("round {0}: LDPlayer={1,6}s  open-emulator={2,6}s  ratio={3}x" -f `
              $r, $ldT, $oeT, $ratio)
  $rows += [pscustomobject]@{ ld = $ldT; oe = $oeT; ratio = $ratio }
}

& $ld quit --index 0 | Out-Null

function Median($v) {
  $s = @($v | Where-Object { $_ -ne $null } | Sort-Object)
  if ($s.Count -eq 0) { return $null }
  return $s[[math]::Floor($s.Count / 2)]
}

Write-Host ''
Write-Host ("median LDPlayer:      {0}s" -f (Median ($rows | ForEach-Object { $_.ld })))
Write-Host ("median open-emulator: {0}s" -f (Median ($rows | ForEach-Object { $_.oe })))
Write-Host ("median ratio:         {0}x  (>1 means open-emulator is faster)" -f `
            (Median ($rows | ForEach-Object { $_.ratio })))
