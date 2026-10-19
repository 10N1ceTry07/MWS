$ErrorActionPreference = 'Stop'
try {
    $ruleName = 'BendingQueue-8765-LocalSubnet'
    if (-not (Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule -Name $ruleName -DisplayName 'Bending Queue (local network)' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8765 -RemoteAddress LocalSubnet -Profile Domain,Private -Program (Join-Path $PSScriptRoot 'runtime\python.exe') | Out-Null
    }
    Write-Host 'Ready: http://192.168.88.113:8765 (Private/Domain network)'
} catch {
    Write-Host 'Run ALLOW-NETWORK.cmd as administrator on the server.' -ForegroundColor Yellow
    Write-Host $_.Exception.Message
    exit 1
}
