$ErrorActionPreference = 'Stop'
$appRoot = $PSScriptRoot
if ($appRoot.StartsWith('\\')) {
    Write-Host 'Copy the program to a LOCAL folder on the server, for example C:\BendingQueue.'
    Write-Host 'Run START-SERVER.cmd ON THE SERVER, not from a network share on another PC.'
    exit 1
}
$pythonPath = Join-Path $appRoot 'runtime\python.exe'
if (-not (Test-Path -LiteralPath $pythonPath)) {
    $pythonPath = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
}
if (-not (Test-Path -LiteralPath $pythonPath)) {
    $found = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($found) { $pythonPath = $found.Source }
}
if (-not (Test-Path -LiteralPath $pythonPath)) {
    Write-Host 'Python 3.10+ is required. Install Python or use the original computer.'
    Read-Host 'Press Enter to close'
    exit 1
}
$appUrl = 'http://127.0.0.1:8765'
$serverReady = $false
try {
    $response = Invoke-WebRequest "$appUrl/api/orders" -UseBasicParsing -TimeoutSec 2
    $serverReady = $response.StatusCode -eq 200
} catch {}
if (-not $serverReady) {
    Start-Process -FilePath $pythonPath -ArgumentList @('"' + (Join-Path $appRoot 'server.py') + '"') -WorkingDirectory $appRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $appRoot 'server-output.log') -RedirectStandardError (Join-Path $appRoot 'server-error.log')
}
for ($attempt = 0; -not $serverReady -and $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 300
    try {
        $response = Invoke-WebRequest "$appUrl/api/orders" -UseBasicParsing -TimeoutSec 1
        $serverReady = $response.StatusCode -eq 200
    } catch {}
}
if ($serverReady) {
    try { Start-Process $appUrl } catch { Write-Host "Open in your browser: $appUrl" }
    exit
}
Write-Host 'Could not start the app on port 8765.'
if (Test-Path -LiteralPath (Join-Path $appRoot 'server-error.log')) {
    Get-Content -LiteralPath (Join-Path $appRoot 'server-error.log')
}
Read-Host 'Press Enter to close'
exit 1
