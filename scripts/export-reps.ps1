# Regenerates src/reps.json from the Quilt-Population-Master tab of the reference workbook.
# Usage (from the repo root):  powershell -File scripts\export-reps.ps1 [-Workbook path.xlsx] [-AsOf 2026-10-01]
# A rep is "current" when their latest row on or before AsOf has Status = Active. Only name, role,
# pod and unit are written out; salary and OTE columns are never copied.
param(
  [string]$Workbook = (Join-Path $PSScriptRoot '..\spif-process-reference.xlsx'),
  [datetime]$AsOf = (Get-Date -Day 1).Date
)
Add-Type -AssemblyName System.IO.Compression.FileSystem
$z = [IO.Compression.ZipFile]::OpenRead((Resolve-Path $Workbook))
function ReadEntry($n) { $e = $z.GetEntry($n); $r = New-Object IO.StreamReader($e.Open()); $t = $r.ReadToEnd(); $r.Close(); $t }
try {
  $ss = [xml](ReadEntry 'xl/sharedStrings.xml')
  $strings = @($ss.sst.si | ForEach-Object {
    if ($_.t -is [string]) { $_.t } elseif ($_.t.'#text') { $_.t.'#text' } else { ($_.r | ForEach-Object { $_.t.'#text' }) -join '' }
  })
  $wb = [xml](ReadEntry 'xl/workbook.xml')
  $rels = [xml](ReadEntry 'xl/_rels/workbook.xml.rels')
  $sheet = $wb.workbook.sheets.sheet | Where-Object name -eq 'Quilt-Population-Master'
  if (-not $sheet) { throw "No 'Quilt-Population-Master' tab in $Workbook" }
  $rid = $sheet.GetAttribute('id', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships')
  $target = ($rels.Relationships.Relationship | Where-Object Id -eq $rid).Target
  $x = [xml](ReadEntry ('xl/' + $target))
  # Row 1 is a title row and row 2 holds the headers; data starts on row 3.
  $recs = foreach ($row in ($x.worksheet.sheetData.row | Select-Object -Skip 2)) {
    $h = @{}
    foreach ($c in $row.c) {
      $v = $c.v
      if ($c.t -eq 's') { $v = $strings[[int]$v] }
      $h[($c.r -replace '\d', '')] = $v
    }
    if (-not $h['A']) { continue }
    [pscustomobject]@{ Name = $h['A'].Trim(); Status = $h['B']; Start = [DateTime]::FromOADate([double]$h['D']); Role = $h['J']; Pod = $h['P']; Unit = $h['Q'] }
  }
} finally { $z.Dispose() }

$current = $recs | Where-Object { $_.Start -le $AsOf } | Group-Object Name | ForEach-Object {
  $_.Group | Sort-Object Start | Select-Object -Last 1
} | Where-Object Status -eq 'Active' | Sort-Object Name

$out = @($current | ForEach-Object { [ordered]@{ name = $_.Name; role = $_.Role; pod = $_.Pod; unit = $_.Unit } })
$json = ConvertTo-Json -InputObject $out -Depth 3
$dest = Join-Path $PSScriptRoot '..\src\reps.json'
[IO.File]::WriteAllText([IO.Path]::GetFullPath($dest), $json + "`n", (New-Object Text.UTF8Encoding($false)))
"Wrote $($out.Count) reps (as of $($AsOf.ToString('yyyy-MM-dd'))) to src\reps.json"
