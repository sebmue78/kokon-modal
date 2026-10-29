# Manual test of a first install: Kokon as a new user sees it (welcome, setup, the whole download of the
# engine and the model files) in an isolated profile under -Dir (default D:\KokonTest): its own config,
# data, ports, images and stable-diffusion.cpp folder. The installed Kokon, %APPDATA%\Kokon\config.json
# and %LOCALAPPDATA%\KokonData are never written to.
#
# The download is real: about 12 GB (16 GB preset; it depends on the card), so -Dir needs the room.
#
#   powershell -ExecutionPolicy Bypass -File scripts\dev\test-fresh-setup.ps1 [-Action <action>] [-Dir <folder>] [-Reset]
#
# Actions
#   setup  (default) Start Kokon on the test profile (npm run tauri dev). The first run is a new install;
#          a second run is a restart (what was downloaded and saved is kept).
#          -Reset  start again as a new install: deletes -Dir (the downloaded files too).
#   stop   Stop the test service and its sd-server (they outlive the window).
#
# Close the installed Kokon first: both would load a model on the same GPU.
param(
    [ValidateSet('setup', 'stop')] [string]$Action = 'setup',
    [string]$Dir = 'D:\KokonTest',
    [switch]$Reset
)

$ErrorActionPreference = 'Stop'
$root = Resolve-Path "$PSScriptRoot\..\.."
$data = Join-Path $Dir 'data'
$config = Join-Path $Dir 'config'
$sdcpp = Join-Path $Dir 'sdcpp'
$realConfig = Join-Path $env:APPDATA 'Kokon\config.json'

function RealConfigHash {
    if (Test-Path $realConfig) { (Get-FileHash $realConfig -Algorithm SHA256).Hash.Substring(0, 16) } else { 'none' }
}

function StopTestProcesses {
    $mine = Get-Process kokon-service, sd-server -ErrorAction SilentlyContinue | Where-Object { $_.Path -and ($_.Path.StartsWith("$root\target", 'OrdinalIgnoreCase') -or $_.Path.StartsWith("$Dir", 'OrdinalIgnoreCase')) }
    foreach ($p in $mine) {
        Write-Host "Stopping $($p.Name) ($($p.Path))"
        Stop-Process -Id $p.Id -Force
    }
    if (-not $mine) { Write-Host 'No test processes running.' }
}

if ($Action -eq 'stop') {
    StopTestProcesses
    return
}

# Never the real install: -Dir must not be (or hold) Kokon's own folders.
$full = [IO.Path]::GetFullPath($Dir).TrimEnd('\')
foreach ($real in @((Join-Path $env:LOCALAPPDATA 'KokonData'), (Join-Path $env:APPDATA 'Kokon'))) {
    if ($real.StartsWith($full, 'OrdinalIgnoreCase') -or $full.StartsWith($real, 'OrdinalIgnoreCase')) { throw "-Dir $Dir overlaps the installed Kokon ($real)." }
}
if (Get-Process sd-server -ErrorAction SilentlyContinue) { Write-Warning "sd-server is running: close Kokon first, or both load a model on the GPU." }

StopTestProcesses
if ($Reset -and (Test-Path $Dir)) {
    Write-Host "Deleting $Dir (new install)"
    Remove-Item -Recurse -Force $Dir
}
New-Item -ItemType Directory -Force $data, $config, $sdcpp, (Join-Path $Dir 'output') | Out-Null

# A new install, except where files go: the engine and the models in the test folder (the default would
# be the installed Kokon's, already complete), other ports, images in the test folder. Nothing marked as
# seen, so the welcome and the setup come first.
$cfgFile = Join-Path $config 'config.json'
if (-not (Test-Path $cfgFile)) {
    $cfg = @{ schemaVersion = 10; sdcppDir = "$sdcpp"; serverPort = 39194; servicePort = 39195; outputDir = (Join-Path $Dir 'output') }
    # UTF-8 without BOM (Set-Content -Encoding utf8 in PowerShell 5.1 writes one; Kokon accepts both).
    [IO.File]::WriteAllText($cfgFile, ($cfg | ConvertTo-Json -Depth 5))
} else {
    Write-Host "Keeping the saved test profile (use -Reset to start again as a new install)."
}

$free = (Get-PSDrive ([IO.Path]::GetPathRoot($full).Substring(0, 1))).Free
Write-Host ("Test install: {0} ({1:N0} GB free)" -f $Dir, ($free / 1GB)) -ForegroundColor Cyan
Write-Host "Real config.json (must not change): $(RealConfigHash)"
Write-Host "Starting Kokon on it (close the window to stop)..." -ForegroundColor Cyan
$env:QLS_DATA_DIR = $data
$env:QLS_CONFIG_DIR = $config
Push-Location $root
try { npm run tauri dev } finally { Pop-Location }
