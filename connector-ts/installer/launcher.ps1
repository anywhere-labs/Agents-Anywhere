# ported from effi-crew cloud/installer/launcher.ps1 @30f8334.
# Windows launcher (a hidden scheduled task runs this): like launcher.sh — exit 75 switches to <app>\pending,
# exit 0 stops, crashes restart, a new version failing 3 times within two minutes goes back to the previous one.
$App = Split-Path -Parent $MyInvocation.MyCommand.Path
$env:AA_CONNECTOR_APP_ROOT = $App
$fails = 0
while ($true) {
  $pending = Join-Path $App "pending"
  if (Test-Path $pending) {
    $v = (Get-Content $pending -Raw).Trim(); Remove-Item $pending -Force
    if (Test-Path (Join-Path $App "versions\$v\VERSION")) {
      Copy-Item (Join-Path $App "current.txt") (Join-Path $App "previous.txt") -Force -ErrorAction SilentlyContinue
      Set-Content -Path (Join-Path $App "current.txt") -Value "versions\$v" -NoNewline
      $fails = 0
    }
  }
  $current = (Get-Content (Join-Path $App "current.txt") -Raw).Trim()
  $started = Get-Date
  & (Join-Path $App "$current\bin\anywhere-cli.exe") @args
  $code = $LASTEXITCODE
  if ($code -eq 75) { continue }
  if ($code -eq 0) { exit 0 }
  if (((Get-Date) - $started).TotalSeconds -lt 120) { $fails++ } else { $fails = 0 }
  if ($fails -ge 3 -and (Test-Path (Join-Path $App "previous.txt"))) {
    Move-Item (Join-Path $App "previous.txt") (Join-Path $App "current.txt") -Force
    $fails = 0
  }
  Start-Sleep -Seconds ($fails * 5 + 1)
}
