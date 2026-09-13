#Requires -Version 5.1
<#
.SYNOPSIS
    Reproducible build of the unmodified upstream PokeRogue client for the PokeRogue Offline wrapper.

.DESCRIPTION
    Clones pagefaultgames/pokerogue at a pinned tag (with the `assets` and `locales` submodules),
    drops in an untracked Vite mode file `.env.offline`, installs with a frozen lockfile,
    runs `vite build --mode offline`, verifies the produced bundle, copies it to -OutDir and
    zips it to game-<tag>.zip + game-<tag>.zip.sha256.

    No upstream source file is modified. The only added file is `.env.offline`, which upstream's
    own Vite config picks up via `--mode offline` (see README.md).

.PARAMETER Tag
    Upstream git tag to build, e.g. v1.12.0.11. Must match the tag pinned in DESIGN.md section 1.

.PARAMETER OutDir
    Directory that receives the built game. index.html lands at the root of this directory.

.PARAMETER WorkDir
    Scratch directory for the clone. Wiped unless -ReuseClone is given.

.PARAMETER ZipDir
    Directory that receives game-<tag>.zip and game-<tag>.zip.sha256. Defaults to OutDir's parent.

.PARAMETER ServerUrl
    API base compiled into the bundle. Fixed by DESIGN.md section 1; override only for experiments.

.PARAMETER ReuseClone
    Reuse an existing clone in WorkDir instead of re-cloning (fast iteration; not reproducible).

.PARAMETER NoZip
    Skip the zip + sha256 step.

.EXAMPLE
    .\build-game.ps1 -Tag v1.12.0.11 -OutDir C:\dev\pokerogue-offline\game-build\dist\game
#>
[CmdletBinding()]
param(
    [string] $Tag = 'v1.12.0.11',
    [string] $OutDir = (Join-Path $PSScriptRoot 'dist\game'),
    [string] $WorkDir = (Join-Path $PSScriptRoot 'work'),
    [string] $ZipDir = '',
    [string] $ServerUrl = 'http://127.0.0.1:47830/api',
    [switch] $ReuseClone,
    [switch] $NoZip
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoUrl = 'https://github.com/pagefaultgames/pokerogue.git'
$CloneDir = Join-Path $WorkDir 'pokerogue'
if (-not $ZipDir) { $ZipDir = Split-Path -Parent $OutDir }

function Write-Step([string] $Message) {
    Write-Host ''
    Write-Host "=== $Message" -ForegroundColor Cyan
}

function Invoke-Checked([string] $What, [scriptblock] $Block) {
    # git/vite/pnpm write progress to stderr; with $ErrorActionPreference = 'Stop' PowerShell 5.1
    # turns those lines into terminating NativeCommandError records. Branch on the exit code instead.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $Block } finally { $ErrorActionPreference = $previous }
    if ($LASTEXITCODE -ne 0) { throw "$What failed with exit code $LASTEXITCODE" }
}

# --- locate toolchain -------------------------------------------------------
$pnpm = Join-Path $env:APPDATA 'npm\pnpm.cmd'
if (-not (Test-Path -LiteralPath $pnpm)) {
    $cmd = Get-Command pnpm -ErrorAction SilentlyContinue
    if (-not $cmd) { throw 'pnpm not found. Install it (npm i -g pnpm) or put it on PATH.' }
    $pnpm = $cmd.Source
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    $nodeDir = 'C:\Program Files\nodejs'
    if (Test-Path -LiteralPath $nodeDir) { $env:Path = "$nodeDir;$env:Path" }
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node not found on PATH.' }
if (-not (Get-Command git  -ErrorAction SilentlyContinue)) { throw 'git not found on PATH.' }

$totalSw = [Diagnostics.Stopwatch]::StartNew()
$timings = [ordered]@{}

Write-Host "PokeRogue Offline - game build" -ForegroundColor Green
Write-Host "  tag        : $Tag"
Write-Host "  server url : $ServerUrl"
Write-Host "  out dir    : $OutDir"
Write-Host "  node       : $((node -v))"
Write-Host "  pnpm       : $((& $pnpm -v))"

# --- 1. clone ---------------------------------------------------------------
if ($ReuseClone -and (Test-Path -LiteralPath (Join-Path $CloneDir 'package.json'))) {
    Write-Step "Reusing existing clone at $CloneDir"
} else {
    Write-Step "Cloning $RepoUrl at $Tag (with submodules)"
    $sw = [Diagnostics.Stopwatch]::StartNew()
    if (Test-Path -LiteralPath $CloneDir) { Remove-Item -Recurse -Force -LiteralPath $CloneDir }
    New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
    Invoke-Checked 'git clone' {
        git clone --depth 1 --branch $Tag --recurse-submodules --shallow-submodules $RepoUrl $CloneDir
    }
    $timings['clone'] = $sw.Elapsed
}

$upstreamSha = (git -C $CloneDir rev-parse HEAD).Trim()
$gameVersion = (Get-Content -Raw -LiteralPath (Join-Path $CloneDir 'package.json') | ConvertFrom-Json).version
Write-Host "  upstream sha : $upstreamSha"
Write-Host "  game version : $gameVersion"
if ("v$gameVersion" -ne $Tag) {
    Write-Warning "package.json version ($gameVersion) does not match tag ($Tag)."
}

# --- 2. .env.offline --------------------------------------------------------
Write-Step 'Writing .env.offline (untracked; no tracked file is modified)'
$prodEnv = @{}
Get-Content -LiteralPath (Join-Path $CloneDir '.env.production') |
    Where-Object { $_ -match '^\s*VITE_' } |
    ForEach-Object { $k, $v = $_ -split '=', 2; $prodEnv[$k.Trim()] = $v.Trim() }

foreach ($required in 'VITE_DISCORD_CLIENT_ID', 'VITE_GOOGLE_CLIENT_ID') {
    if (-not $prodEnv.ContainsKey($required)) { throw "$required missing from upstream .env.production" }
}

$envLines = @(
    '# Generated by build-game.ps1 - do not commit into the upstream clone.'
    '# Login ENABLED; API base points at the wrapper proxy on the same origin as the served game.'
    'VITE_BYPASS_LOGIN=0'
    'VITE_BYPASS_TUTORIAL=0'
    "VITE_SERVER_URL=$ServerUrl"
    '# Copied verbatim from upstream .env.production; OAuth buttons are hidden/disabled by the wrapper.'
    "VITE_DISCORD_CLIENT_ID=$($prodEnv['VITE_DISCORD_CLIENT_ID'])"
    "VITE_GOOGLE_CLIENT_ID=$($prodEnv['VITE_GOOGLE_CLIENT_ID'])"
    'VITE_I18N_DEBUG=0'
)
# UTF-8 *without* BOM: PowerShell 5.1's -Encoding utf8 emits a BOM, which trips up
# dotenv parsers and JSON.parse. Write the bytes ourselves.
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $CloneDir '.env.offline'), ($envLines -join "`n") + "`n", $utf8NoBom)
$envLines | ForEach-Object { Write-Host "  $_" }

# --- 3. install -------------------------------------------------------------
Write-Step 'pnpm install --frozen-lockfile'
$sw = [Diagnostics.Stopwatch]::StartNew()
Push-Location $CloneDir
try {
    Invoke-Checked 'pnpm install' { & $pnpm install --frozen-lockfile }
    $timings['install'] = $sw.Elapsed

    # --- 4. build -----------------------------------------------------------
    Write-Step 'pnpm vite build --mode offline'
    $sw = [Diagnostics.Stopwatch]::StartNew()
    Invoke-Checked 'vite build' { & $pnpm vite build --mode offline }
    $timings['build'] = $sw.Elapsed
} finally {
    Pop-Location
}

$distDir = Join-Path $CloneDir 'dist'
if (-not (Test-Path -LiteralPath (Join-Path $distDir 'index.html'))) { throw "No index.html in $distDir" }

# --- 5. verify --------------------------------------------------------------
Write-Step 'Verifying bundle'
$jsFiles = Get-ChildItem -LiteralPath (Join-Path $distDir 'assets') -File -Filter *.js
$jsText = ($jsFiles | ForEach-Object { Get-Content -Raw -LiteralPath $_.FullName }) -join "`n"

$expectedBase = [regex]::Escape($ServerUrl)
if ($jsText -notmatch $expectedBase) { throw "VERIFY FAILED: '$ServerUrl' not found in the JS bundle." }
Write-Host "  [ok] API base '$ServerUrl' is compiled into the bundle"

if ($jsText -match 'api\.pokerogue\.net') { throw 'VERIFY FAILED: api.pokerogue.net is present in the JS bundle.' }
Write-Host '  [ok] api.pokerogue.net absent from the JS bundle'

if ($jsText -match 'VITE_BYPASS_LOGIN') { throw 'VERIFY FAILED: VITE_BYPASS_LOGIN was not substituted at build time.' }

# bypassLogin === false proof: with bypassLogin true, encrypt()/decrypt() at the save call sites
# fold to btoa/atob and the savedata endpoints get dropped. With it false, AES + the endpoints remain.
foreach ($endpoint in '/account/login', '/account/info', '/savedata/system/get', '/savedata/system/update', '/savedata/updateall') {
    if ($jsText -notmatch [regex]::Escape($endpoint)) { throw "VERIFY FAILED: endpoint '$endpoint' missing - bypassLogin may have compiled to true." }
}
Write-Host '  [ok] bypassLogin compiled to false (login + savedata endpoints present, no bypass folding)'

$indexHtml = Get-Content -Raw -LiteralPath (Join-Path $distDir 'index.html')
if ($indexHtml -notmatch 'src="\./assets/') { throw 'VERIFY FAILED: index.html does not use relative ./assets/ paths.' }
Write-Host '  [ok] index.html references assets with relative ./ paths'

foreach ($needed in 'manifest.webmanifest', 'service-worker.js', 'locales\en\common.json', 'images', 'audio', 'fonts') {
    if (-not (Test-Path -LiteralPath (Join-Path $distDir $needed))) { throw "VERIFY FAILED: missing '$needed' in dist." }
}
Write-Host '  [ok] assets, locales, manifest and service worker present'

# --- 6. publish to OutDir ---------------------------------------------------
Write-Step "Copying build to $OutDir"
$sw = [Diagnostics.Stopwatch]::StartNew()
if (Test-Path -LiteralPath $OutDir) { Remove-Item -Recurse -Force -LiteralPath $OutDir }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutDir) | Out-Null
Copy-Item -LiteralPath $distDir -Destination $OutDir -Recurse -Force
$timings['copy'] = $sw.Elapsed

$outFiles = Get-ChildItem -Recurse -File -LiteralPath $OutDir
$outBytes = ($outFiles | Measure-Object Length -Sum).Sum
Write-Host ("  {0} files, {1:N1} MB" -f $outFiles.Count, ($outBytes / 1MB))

$versionJson = [ordered]@{
    tag         = $Tag
    upstreamSha = $upstreamSha
    gameVersion = $gameVersion
    serverUrl   = $ServerUrl
    builtAt     = (Get-Date).ToUniversalTime().ToString('o')
}
New-Item -ItemType Directory -Force -Path $ZipDir | Out-Null
[System.IO.File]::WriteAllText((Join-Path $ZipDir 'version.json'), ($versionJson | ConvertTo-Json), $utf8NoBom)
# Also inside the game folder itself: the app reads <gameDir>/version.json to know what it is serving.
[System.IO.File]::WriteAllText((Join-Path $OutDir 'version.json'), ($versionJson | ConvertTo-Json), $utf8NoBom)

# --- 7. zip + sha256 --------------------------------------------------------
if (-not $NoZip) {
    Write-Step 'Packaging'
    $sw = [Diagnostics.Stopwatch]::StartNew()
    New-Item -ItemType Directory -Force -Path $ZipDir | Out-Null
    $zipPath = Join-Path $ZipDir "game-$Tag.zip"
    if (Test-Path -LiteralPath $zipPath) { Remove-Item -Force -LiteralPath $zipPath }

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    # Fastest: the payload is mostly pre-compressed mp3/png, deflate buys almost nothing.
    [System.IO.Compression.ZipFile]::CreateFromDirectory(
        $OutDir, $zipPath, [System.IO.Compression.CompressionLevel]::Fastest, $false)

    $hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLower()
    "$hash  game-$Tag.zip" | Set-Content -LiteralPath "$zipPath.sha256" -Encoding ascii
    $timings['zip'] = $sw.Elapsed
    Write-Host ("  {0} ({1:N1} MB)" -f $zipPath, ((Get-Item -LiteralPath $zipPath).Length / 1MB))
    Write-Host "  sha256 $hash"
}

# --- done -------------------------------------------------------------------
$totalSw.Stop()
Write-Step 'Done'
foreach ($k in $timings.Keys) { Write-Host ("  {0,-8} {1,6:N1}s" -f $k, $timings[$k].TotalSeconds) }
Write-Host ("  {0,-8} {1,6:N1}s" -f 'total', $totalSw.Elapsed.TotalSeconds)
Write-Host ''
Write-Host "Game built at: $OutDir" -ForegroundColor Green
