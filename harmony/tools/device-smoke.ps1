<#
.SYNOPSIS
  Device helpers for the HarmonyOS smoke tests.

.DESCRIPTION
  Dot-source this file, then drive the phone with Get-Ui / Find-Ui / Click-Row /
  LongClick-Row / Shot.

  It lives in the repository because it used to sit in %TEMP%, where a Windows
  temp cleanup deleted it together with the logic-check suite. Adjust $Device if
  you test on a different handset.

.NOTES
  `uitest dumpLayout` does NOT capture popup overlays (bindMenu, sheets) — judge
  those from `Shot` screenshots instead. Coordinates must come from a fresh dump
  because the layout shifts as data arrives.
#>

$Device = '62T0225B18043858'
$HdcPath = 'C:\Program Files\Huawei\DevEco Studio\sdk\default\openharmony\toolchains\hdc.exe'

function Hdc {
  & $HdcPath -t $Device shell ($args -join ' ')
}

function Assert-Device {
  $targets = & $HdcPath list targets 2>&1
  if ("$targets" -notmatch [regex]::Escape($Device)) {
    throw "device $Device is not connected (hdc list targets: $targets)"
  }
}

function Get-Ui([string]$tag) {
  Assert-Device
  $remote = "/data/local/tmp/$tag.json"
  & $HdcPath -t $Device shell "uitest dumpLayout -p $remote" | Out-Null
  $local = Join-Path $env:TEMP "$tag.json"
  if (Test-Path $local) { Remove-Item $local -Force }
  & $HdcPath -t $Device file recv $remote $local | Out-Null
  if (-not (Test-Path $local)) {
    # The dump failed. Say so here rather than returning a null tree, which used
    # to surface as a confusing "cannot find path" from ConvertFrom-Json.
    throw "dumpLayout produced no file for tag $tag (is the app running?)"
  }
  return (Get-Content $local -Raw -Encoding UTF8 | ConvertFrom-Json)
}

function Get-Bounds($node) {
  if ($null -eq $node) { return $null }
  $b = $node.attributes.bounds
  if (-not $b) { return $null }
  $m = [regex]::Match($b, '\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]')
  if (-not $m.Success) { return $null }
  return @([int]$m.Groups[1].Value, [int]$m.Groups[2].Value,
    [int]$m.Groups[3].Value, [int]$m.Groups[4].Value)
}

function Find-Ui($tree, $pattern) {
  $script:found = New-Object System.Collections.ArrayList
  $script:pat = $pattern
  function Walk($n) {
    $t = $n.attributes.text
    if ($t -and $t -match $script:pat) { [void]$script:found.Add($n) }
    foreach ($c in $n.children) { Walk $c }
  }
  Walk $tree
  return $script:found
}

function Row-Info($node) {
  $b = Get-Bounds $node
  $bounds = 'none'
  if ($b) { $bounds = $b -join ',' }
  Write-Output ("text='{0}' type={1} bounds=[{2}] children={3}" -f `
      $node.attributes.text, $node.attributes.type, $bounds, $node.children.Count)
}

function Click-Row($node) {
  $b = Get-Bounds $node
  if (-not $b) { Write-Output 'no bounds'; return }
  $x = [int](($b[0] + $b[2]) / 2)
  $y = [int](($b[1] + $b[3]) / 2)
  & $HdcPath -t $Device shell "uitest uiInput click $x $y" | ForEach-Object { $_ }
}

function LongClick-Row($node) {
  $b = Get-Bounds $node
  if (-not $b) { Write-Output 'no bounds'; return }
  $x = [int](($b[0] + $b[2]) / 2)
  $y = [int](($b[1] + $b[3]) / 2)
  & $HdcPath -t $Device shell "uitest uiInput longClick $x $y" | ForEach-Object { $_ }
}

function Shot($path) {
  & $HdcPath -t $Device shell 'snapshot_display -f /data/local/tmp/shot.jpeg' | Out-Null
  & $HdcPath -t $Device file recv /data/local/tmp/shot.jpeg $path | Out-Null
}
