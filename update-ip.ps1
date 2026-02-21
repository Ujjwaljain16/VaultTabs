# update-ip.ps1 - VaultTabs One-Click Reset
$root = $PSScriptRoot
if (-not $root) { $root = Get-Location }

Write-Host "VaultTabs IP Reset Starting..."

# 1. Detect IP
$adapters = Get-NetIPAddress -AddressFamily IPv4 | Where-Object InterfaceAlias -match "Tailscale|Wi-Fi|Ethernet"
$ip = ($adapters | Where-Object InterfaceAlias -like "*Tailscale*" | Select-Object -ExpandProperty IPAddress -First 1)
if (-not $ip) {
    $ip = ($adapters | Where-Object InterfaceAlias -like "*Wi-Fi*" | Select-Object -ExpandProperty IPAddress -First 1)
}
if (-not $ip) {
    $ip = ($adapters | Select-Object -ExpandProperty IPAddress -First 1)
}

if (-not $ip) {
    Write-Host "Error: Could not find a network IP."
    exit 1
}

Write-Host "Detected IP: $ip"

# 2. Certs
$certPath = "$root/certs"
$hasCert = Test-Path $certPath
if ($hasCert) {
    Write-Host "Updating SSL certificate..."
    Set-Location $certPath
    & mkcert "$ip"
    Set-Location $root
}

# 3. Synchronize All Configs
$targetFiles = @(
    "$root/extension/utils/api.ts",
    "$root/pwa/.env.local",
    "$root/backend/.env"
)

# This regex is now ultra-specific: it finds the base URL regardless of what IP/port was there
# and ensures it ends with /api/v1 (which the backend expects)
$searchRegex = 'https://[^/]*?/(api/)?v1'
$replacement = "https://${ip}:3000/api/v1"

foreach ($file in $targetFiles) {
    $exists = Test-Path $file
    if ($exists) {
        $text = Get-Content $file
        $text = $text -replace $searchRegex, $replacement
        
        # Also sync PUBLIC_IP env variable
        if ($file -like "*.env*") {
            if ($text -match "PUBLIC_IP=") {
                $text = $text -replace "PUBLIC_IP=.*", "PUBLIC_IP=$ip"
            } else {
                $text += "`nPUBLIC_IP=$ip"
            }
        }
        
        $text | Set-Content $file
        Write-Host "Synced: $file"
    }
}

Write-Host "RESET COMPLETE!"
Write-Host "1. Restart backend"
Write-Host "2. Reload extension"
Write-Host "3. Visit https://${ip}:3000/health"
