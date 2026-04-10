$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repoRoot = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $repoRoot "data"
$outFile = Join-Path $dataDir "us-parks.json"

New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

Write-Host "Downloading all_parks_ext.csv from POTA..."
$csv = Invoke-WebRequest -UseBasicParsing -Uri "https://pota.app/all_parks_ext.csv" -TimeoutSec 180

Write-Host "Filtering active US parks..."
$rows = $csv.Content | ConvertFrom-Csv
$us = $rows |
  Where-Object { $_.reference -like "US-*" -and $_.active -eq "1" } |
  ForEach-Object {
    [pscustomobject]@{
      reference = $_.reference
      name      = $_.name
      location  = $_.locationDesc
      lat       = [double]$_.latitude
      lon       = [double]$_.longitude
      grid      = $_.grid
    }
  }

$json = $us | ConvertTo-Json -Compress -Depth 4
Set-Content -Path $outFile -Value $json -Encoding utf8

Write-Host ("Saved {0} parks to {1}" -f $us.Count, $outFile)
