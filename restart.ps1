$ErrorActionPreference = 'Stop'
try {
    $serverFile = Join-Path $PSScriptRoot 'server.py'
    $listeners = @(Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue)
    foreach ($listener in $listeners) {
        $serverProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
        if (-not $serverProcess.CommandLine -or -not $serverProcess.CommandLine.Contains($serverFile)) {
            throw 'Port 8765 belongs to an unrecognized process. No process was stopped.'
        }
        Stop-Process -Id $serverProcess.ProcessId -ErrorAction Stop
        Wait-Process -Id $serverProcess.ProcessId -Timeout 10 -ErrorAction SilentlyContinue
    }
    & (Join-Path $PSScriptRoot 'start.ps1')
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
