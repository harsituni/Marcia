<#
.SYNOPSIS
  M06: download HiRISE DTM + ortho for the EVA site and clip them to the
  site box from data/site.json on a 5 m equirectangular grid.

.DESCRIPTION
  Outputs (git-ignored):
    data/raw/elev_5m.tif   DTM, bilinear
    data/raw/ortho_5m.tif  ortho image, average
    data/raw/ti_5m.tif     thermal inertia (optional, best effort)
  Sources are downloaded (resumable) into data/raw/src/.
  See data/raw/README.md for sources, CRS and QGIS notes.

  Requires GDAL >= 3.2 (gdalinfo, gdalwarp, gdaltransform) with a JPEG2000
  driver, and curl.exe (built into Windows 10+).

.PARAMETER SkipThermalInertia
  Don't download or clip the optional Zenodo thermal inertia map.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/fetch-clip.ps1
#>
[CmdletBinding()]
param(
  [switch]$SkipThermalInertia
)

$ErrorActionPreference = 'Stop'
$Inv = [Globalization.CultureInfo]::InvariantCulture

$RepoRoot = Split-Path -Parent $PSScriptRoot
$SiteJson = Join-Path $RepoRoot 'data/site.json'
$RawDir = Join-Path $RepoRoot 'data/raw'
$SrcDir = Join-Path $RawDir 'src'

$MarsR = 3396190.0
$CellM = 5.0

# Sources. Do not substitute Jezero_C or ESP_045994 products.
$DtmBase = 'https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/mars2020_trn/HiRISE/DTM_MOLAtopography_DeltaGeoid_Jezero_DL_Edited_affine_1m_Eqc_latTs0_lon0'
$OrthoBase = 'https://hirise.lpl.arizona.edu/PDS/DTM/PSP/ORB_002300_002399/PSP_002387_1985_PSP_003798_1985/PSP_002387_1985_RED_A_01_ORTHO'
$TiUrl = 'https://zenodo.org/records/4931348/files/Jezero_Thermal_Inertia_v1.tiff'

function Fail([string]$msg) {
  Write-Host "ERROR: $msg" -ForegroundColor Red
  exit 1
}

function Step([string]$msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

function Fmt([double]$v) { $v.ToString('R', $Inv) }

# Run a native command; throw if it exits non-zero. Returns stdout.
function Invoke-Native([string]$exe, [string[]]$argv) {
  $out = & $exe @argv
  if ($LASTEXITCODE -ne 0) { throw "$exe failed (exit $LASTEXITCODE): $($argv -join ' ')" }
  return $out
}

# ---------------------------------------------------------------- GDAL check

function Find-Gdal {
  if (Get-Command gdalwarp -ErrorAction SilentlyContinue) { return }
  $roots = @()
  if ($env:CONDA_PREFIX) { $roots += (Join-Path $env:CONDA_PREFIX 'Library') }
  $roots += 'C:\OSGeo4W', 'C:\OSGeo4W64'
  $roots += @(Get-ChildItem 'C:\Program Files\QGIS*' -Directory -ErrorAction SilentlyContinue |
      Sort-Object Name -Descending | ForEach-Object { $_.FullName })
  foreach ($root in $roots) {
    $bin = Join-Path $root 'bin'
    if (Test-Path (Join-Path $bin 'gdalwarp.exe')) {
      Write-Host "Using GDAL from $bin"
      $env:PATH = "$bin;$env:PATH"
      foreach ($p in @((Join-Path $root 'share\proj'))) {
        if (-not $env:PROJ_DATA -and (Test-Path $p)) { $env:PROJ_DATA = $p; $env:PROJ_LIB = $p }
      }
      foreach ($g in @((Join-Path $root 'apps\gdal\share\gdal'), (Join-Path $root 'share\gdal'))) {
        if (-not $env:GDAL_DATA -and (Test-Path $g)) { $env:GDAL_DATA = $g }
      }
      return
    }
  }
}

Step 'Checking tools'
Find-Gdal
foreach ($tool in 'gdalinfo', 'gdalwarp', 'gdaltransform') {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    Fail "$tool not found. Install GDAL (OSGeo4W or conda); see data/raw/README.md > Installing GDAL on Windows."
  }
}
if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) { Fail 'curl.exe not found (ships with Windows 10+).' }

$verLine = (Invoke-Native 'gdalinfo' @('--version')) | Select-Object -First 1
if ($verLine -notmatch 'GDAL (\d+)\.(\d+)') { Fail "Could not parse GDAL version: $verLine" }
if ([int]$Matches[1] -lt 3 -or ([int]$Matches[1] -eq 3 -and [int]$Matches[2] -lt 2)) {
  Fail "GDAL >= 3.2 required, found: $verLine"
}
Write-Host $verLine
$formats = (Invoke-Native 'gdalinfo' @('--formats')) -join "`n"
if ($formats -notmatch 'JP2OpenJPEG|JP2KAK|JP2ECW|JP2MrSID') {
  Fail 'This GDAL build has no JPEG2000 driver (JP2OpenJPEG etc.). Install a full GDAL build (OSGeo4W or conda-forge).'
}

# ---------------------------------------------------------------- site box

Step "Reading $SiteJson"
if (-not (Test-Path $SiteJson)) { Fail "data/site.json not found (M04)." }
$site = Get-Content $SiteJson -Raw | ConvertFrom-Json
$W = [double]$site.bounds.minLon
$S = [double]$site.bounds.minLat
$E = [double]$site.bounds.maxLon
$N = [double]$site.bounds.maxLat
if (-not ($W -lt $E -and $S -lt $N)) { Fail 'site.json bounds are invalid (need minLon<maxLon, minLat<maxLat).' }
$hab = $site.habitat
if ($hab -and -not ($hab.lon -gt $W -and $hab.lon -lt $E -and $hab.lat -gt $S -and $hab.lat -lt $N)) {
  Fail 'site.json habitat is outside the site bounds.'
}
Write-Host ("W/S/E/N = {0} / {1} / {2} / {3}" -f (Fmt $W), (Fmt $S), (Fmt $E), (Fmt $N))

# Target grid: equirectangular, true scale at the box's middle latitude.
$MidLat = ($S + $N) / 2.0
$SiteGeo = "+proj=longlat +R=$(Fmt $MarsR) +no_defs"
$TargetSrs = "+proj=eqc +lat_ts=$(Fmt $MidLat) +lat_0=0 +lon_0=0 +R=$(Fmt $MarsR) +units=m +no_defs"
$deg = [math]::PI / 180.0
$k = $MarsR * [math]::Cos($MidLat * $deg)
$xMin = $W * $deg * $k
$xMax = $E * $deg * $k
$yMin = $S * $deg * $MarsR
$yMax = $N * $deg * $MarsR
$Cols = [int][math]::Round(($xMax - $xMin) / $CellM)
$Rows = [int][math]::Round(($yMax - $yMin) / $CellM)
# Snap the far edges so cells are exactly 5 m.
$xMax = $xMin + $Cols * $CellM
$yMin = $yMax - $Rows * $CellM
$TE = @((Fmt $xMin), (Fmt $yMin), (Fmt $xMax), (Fmt $yMax))
Write-Host "Target: $TargetSrs"
Write-Host "Grid: ${Cols} x ${Rows} cells @ ${CellM} m"

# ---------------------------------------------------------------- downloads

function Get-RemoteSize([string]$url) {
  $hdr = & curl.exe -sIL --max-time 60 $url
  if ($LASTEXITCODE -ne 0) { return $null }
  $len = $hdr | Where-Object { $_ -match '^content-length:\s*(\d+)' } | Select-Object -Last 1
  if ($len -match '(\d+)') { return [int64]$Matches[1] }
  return $null
}

# Resumable download: partial data lives in <dest>.part until complete.
function Save-Resumable([string]$url, [string]$dest) {
  $name = Split-Path -Leaf $dest
  $expected = Get-RemoteSize $url
  if ((Test-Path $dest) -and ($null -eq $expected -or (Get-Item $dest).Length -eq $expected)) {
    Write-Host "  have $name"
    return
  }
  $part = "$dest.part"
  $have = 0
  if (Test-Path $part) { $have = (Get-Item $part).Length }
  if ($null -eq $expected -or $have -lt $expected) {
    if ($have -gt 0) { Write-Host "  resuming $name at $have bytes" } else { Write-Host "  downloading $name" }
    & curl.exe -L --fail --retry 5 --retry-delay 5 --retry-all-errors -C - -o $part $url
    if ($LASTEXITCODE -ne 0) { throw "download failed (curl exit $LASTEXITCODE): $url" }
  }
  $got = (Get-Item $part).Length
  if ($null -ne $expected -and $got -ne $expected) {
    throw "size mismatch for ${name}: got $got, expected $expected. Re-run to resume."
  }
  Move-Item -Force $part $dest
}

Step "Downloading sources into $SrcDir"
New-Item -ItemType Directory -Force $SrcDir | Out-Null
$DtmTif = Join-Path $SrcDir (Split-Path -Leaf "$DtmBase.tif")
$OrthoJp2 = Join-Path $SrcDir (Split-Path -Leaf "$OrthoBase.JP2")
$OrthoLbl = Join-Path $SrcDir (Split-Path -Leaf "$OrthoBase.LBL")
$TiSrc = Join-Path $SrcDir 'Jezero_Thermal_Inertia_v1.tiff'
try {
  Save-Resumable "$DtmBase.tif" $DtmTif
  Save-Resumable "$DtmBase.xml" (Join-Path $SrcDir (Split-Path -Leaf "$DtmBase.xml"))
  Save-Resumable "$OrthoBase.LBL" $OrthoLbl
  Save-Resumable "$OrthoBase.JP2" $OrthoJp2
} catch { Fail $_.Exception.Message }

$HaveTi = $false
if (-not $SkipThermalInertia) {
  try { Save-Resumable $TiUrl $TiSrc; $HaveTi = $true }
  catch { Write-Warning "Optional thermal inertia download failed, skipping: $($_.Exception.Message)" }
}

# ---------------------------------------------------------------- coverage

function Get-Info([string]$path) {
  # -nomd: metadata domains include an empty-string key that PS 5.1's ConvertFrom-Json rejects.
  $txt = & gdalinfo -json -nomd $path
  if ($LASTEXITCODE -ne 0) { return $null }
  return ($txt | Out-String | ConvertFrom-Json)
}

# Feed points to gdaltransform on stdin as plain ASCII. Piping with `|` in
# Windows PowerShell 5.1 prepends a UTF-8 BOM when the console encoding is
# UTF-8, which corrupts the first point.
function Invoke-GdalTransform([string[]]$points, [string[]]$argv) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = (Get-Command gdaltransform).Source
  $psi.Arguments = ($argv | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }) -join ' '
  $psi.UseShellExecute = $false
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  # .NET Framework builds the stdin writer from Console.InputEncoding and flushes
  # its BOM at start; use BOM-less UTF-8 while the process starts.
  $prevIn = [Console]::InputEncoding
  try {
    [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
    $proc = [System.Diagnostics.Process]::Start($psi)
  } finally { [Console]::InputEncoding = $prevIn }
  $bytes = [System.Text.Encoding]::ASCII.GetBytes(($points -join "`n") + "`n")
  $stdin = $proc.StandardInput.BaseStream
  $stdin.Write($bytes, 0, $bytes.Length)
  $stdin.Close()
  $text = $proc.StandardOutput.ReadToEnd()
  $proc.WaitForExit()
  if ($proc.ExitCode -ne 0) { throw "gdaltransform failed (exit $($proc.ExitCode))" }
  return @($text -split "`r?`n" | Where-Object { $_.Trim() })
}

# Fail unless the whole site box (edges densified) lies inside the raster's extent.
function Test-Coverage([string]$label, [string]$path, $info) {
  $wkt = $info.coordinateSystem.wkt
  if (-not $wkt) { throw "$label has no CRS: $path" }
  $wktFile = "$path.srs.wkt"
  [IO.File]::WriteAllText($wktFile, $wkt)

  $pts = New-Object System.Collections.Generic.List[string]
  $steps = 8
  for ($i = 0; $i -le $steps; $i++) {
    $lon = $W + ($E - $W) * $i / $steps
    $lat = $S + ($N - $S) * $i / $steps
    $pts.Add("$(Fmt $lon) $(Fmt $S)"); $pts.Add("$(Fmt $lon) $(Fmt $N)")
    $pts.Add("$(Fmt $W) $(Fmt $lat)"); $pts.Add("$(Fmt $E) $(Fmt $lat)")
  }
  $out = Invoke-GdalTransform $pts @('-s_srs', $SiteGeo, '-t_srs', $wktFile)
  if (@($out).Count -ne $pts.Count) { throw "gdaltransform returned $(@($out).Count) points for $label, expected $($pts.Count)" }

  $ul = $info.cornerCoordinates.upperLeft
  $lr = $info.cornerCoordinates.lowerRight
  $minX = [math]::Min($ul[0], $lr[0]); $maxX = [math]::Max($ul[0], $lr[0])
  $minY = [math]::Min($ul[1], $lr[1]); $maxY = [math]::Max($ul[1], $lr[1])
  foreach ($line in $out) {
    $p = ($line.Trim() -split '\s+')
    $x = [double]::Parse($p[0], $Inv); $y = [double]::Parse($p[1], $Inv)
    if ($x -lt $minX -or $x -gt $maxX -or $y -lt $minY -or $y -gt $maxY) {
      throw ("{0}: site box is not fully inside the source extent (point {1},{2} outside X[{3},{4}] Y[{5},{6}])" -f `
          $label, $x, $y, $minX, $maxX, $minY, $maxY)
    }
  }
  Write-Host "  $label covers the site box"
}

Step 'Checking coverage'
$dtmInfo = Get-Info $DtmTif
if (-not $dtmInfo) { Fail "gdalinfo could not open $DtmTif" }

# Prefer the PDS label (GDAL reads the georeferencing from it); fall back to the JP2's own GeoJP2/GML box.
$OrthoSrc = $null; $orthoInfo = $null
foreach ($cand in @($OrthoLbl, $OrthoJp2)) {
  $inf = Get-Info $cand
  if ($inf -and $inf.coordinateSystem.wkt) { $OrthoSrc = $cand; $orthoInfo = $inf; break }
}
if (-not $OrthoSrc) { Fail 'gdalinfo could not open the ortho with a CRS via the .LBL or the .JP2.' }
Write-Host "  ortho opened via $(Split-Path -Leaf $OrthoSrc)"

try {
  Test-Coverage 'DTM' $DtmTif $dtmInfo
  Test-Coverage 'ortho' $OrthoSrc $orthoInfo
} catch { Fail $_.Exception.Message }

$tiInfo = $null
if ($HaveTi) {
  $tiInfo = Get-Info $TiSrc
  try {
    if (-not $tiInfo) { throw "gdalinfo could not open $TiSrc" }
    Test-Coverage 'thermal inertia' $TiSrc $tiInfo
  } catch {
    Write-Warning "Optional thermal inertia skipped: $($_.Exception.Message)"
    $HaveTi = $false
  }
}

# ---------------------------------------------------------------- clip

function Invoke-Clip([string]$src, [string]$dst, [string]$resampling, [string[]]$extra) {
  $argv = @('-overwrite', '-t_srs', $TargetSrs, '-te') + $TE + @('-ts', "$Cols", "$Rows",
    '-r', $resampling, '-wm', '1024', '-multi', '-wo', 'NUM_THREADS=ALL_CPUS',
    '-co', 'COMPRESS=DEFLATE', '-co', 'TILED=YES') + $extra + @($src, $dst)
  Invoke-Native 'gdalwarp' $argv | Out-Null
  Write-Host "  wrote $dst"
}

# Percentage of non-nodata cells in band 1 (computed from all pixels).
function Get-ValidPercent([string]$path) {
  $txt = (Invoke-Native 'gdalinfo' @('-stats', $path)) -join "`n"
  if ($txt -match 'STATISTICS_VALID_PERCENT=([0-9.eE+-]+)') { return [double]::Parse($Matches[1], $Inv) }
  throw "gdalinfo did not report STATISTICS_VALID_PERCENT for $path"
}

Step "Clipping to $RawDir"
$ElevOut = Join-Path $RawDir 'elev_5m.tif'
$OrthoOut = Join-Path $RawDir 'ortho_5m.tif'
$TiOut = Join-Path $RawDir 'ti_5m.tif'

try {
  Invoke-Clip $DtmTif $ElevOut 'bilinear' @('-ot', 'Float32', '-dstnodata', '-3.4028234663852886e+38')

  # HiRISE orthos use 0 as fill; treat it as nodata if the source doesn't declare one.
  $orthoExtra = @('-dstnodata', '0')
  if ($null -eq $orthoInfo.bands[0].noDataValue) { $orthoExtra = @('-srcnodata', '0') + $orthoExtra }
  Invoke-Clip $OrthoSrc $OrthoOut 'average' $orthoExtra

  if ($HaveTi) {
    try { Invoke-Clip $TiSrc $TiOut 'bilinear' @('-ot', 'Float32', '-dstnodata', '-9999') }
    catch { Write-Warning "Optional thermal inertia clip failed: $($_.Exception.Message)" }
  }
} catch { Fail $_.Exception.Message }

# ---------------------------------------------------------------- validate

Step 'Validating outputs'
try {
  $ev = Get-ValidPercent $ElevOut
  if ($ev -lt 100) { Fail ("elev_5m.tif has nodata cells ({0}% valid): the site box is not fully inside the DTM's valid data." -f $ev) }
  Write-Host '  elev_5m.tif: no nodata cells'

  $ov = Get-ValidPercent $OrthoOut
  if ($ov -lt 100) { Fail ("ortho_5m.tif has nodata cells ({0}% valid): the site box is not fully inside the ortho's valid data." -f $ov) }
  Write-Host '  ortho_5m.tif: no nodata cells'

  if ($HaveTi -and (Test-Path $TiOut)) {
    $tv = Get-ValidPercent $TiOut
    if ($tv -lt 100) { Write-Warning ("ti_5m.tif is {0}% valid (optional layer, not fatal)." -f $tv) }
    else { Write-Host '  ti_5m.tif: no nodata cells' }
  }
} catch { Fail $_.Exception.Message }

Step "Done. Open data/raw/*.tif in QGIS (see data/raw/README.md)."
