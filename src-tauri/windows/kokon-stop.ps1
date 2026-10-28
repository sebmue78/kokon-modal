# Stops Kokon Modal's background processes (never Kokon's: only its own install and data folders) so the installer can replace (or the uninstaller remove)
# their files. Run by hooks.nsh before installing, updating and uninstalling.
#   -InstDir  Kokon's install folder: only executables inside it (and the inference server in
#             Kokon's data folder) are stopped, never another copy of sd-server.
#   -DryRun   List what would be stopped.
param([Parameter(Mandatory = $true)][string]$InstDir, [switch]$DryRun)

$ErrorActionPreference = 'SilentlyContinue'
$data = Join-Path $env:LOCALAPPDATA 'KokonModalData'
$roots = @($InstDir.TrimEnd('\') + '\')

# Win32_Process gives the path even across 32/64-bit (the installer itself is 32-bit).
function Find([string[]]$names, [string[]]$under) {
    Get-CimInstance Win32_Process | Where-Object {
        $p = $_
        ($names -contains $p.Name) -and $p.ExecutablePath -and ($under | Where-Object { $p.ExecutablePath.StartsWith($_, [StringComparison]::OrdinalIgnoreCase) })
    }
}

function Stop([object[]]$procs) {
    foreach ($p in $procs) {
        if ($DryRun) { Write-Output "would stop $($p.ProcessId) $($p.ExecutablePath)" }
        else { Stop-Process -Id $p.ProcessId -Force }
    }
}

$services = @('kokon-service.exe', 'qls-service.exe')

# 1. The MCP servers (Claude and other agents) first: they would start the service again.
Stop (Find @('kokon-mcp.exe', 'qls-mcp.exe') $roots)

# 2. Ask the service to exit, so it unloads the model the normal way.
$running = Find $services $roots
if ($running -and -not $DryRun) {
    $info = Get-Content (Join-Path $data 'service.json') -Raw | ConvertFrom-Json
    if ($info -and ($running.ProcessId -contains $info.pid)) {
        Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$($info.port)/api/v1/shutdown" -Headers @{ Authorization = "Bearer $($info.token)" } -TimeoutSec 3 | Out-Null
        $deadline = (Get-Date).AddSeconds(8)
        while ((Find $services $roots) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
    }
}

# 3. Whatever is still running.
Stop (Find $services $roots)
Stop (Find @('sd-server.exe') @($data.TrimEnd('\') + '\'))
exit 0
