$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

try {
    $nodeVersion = [version](node -p "process.versions.node")
} catch {
    Write-Host "Node.js is not installed or is not available in PATH. Install Node.js 22.5 or newer, then open this launcher again." -ForegroundColor Red
    return
}

if ($nodeVersion -lt [version]"22.5.0") {
    Write-Host "This project needs Node.js 22.5 or newer. Current version: $(node --version)" -ForegroundColor Red
    return
}

if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot "node_modules"))) {
    Write-Host "Installing the project dependencies..." -ForegroundColor Cyan
    npm ci --ignore-scripts
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Dependency installation failed. Check the message above and try again." -ForegroundColor Red
        return
    }
}

$env:ADMIN_EMAIL = Read-Host "Local admin email"
$securePassword = Read-Host "Local admin password (at least 12 characters)" -AsSecureString
$passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
try {
    $env:ADMIN_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
}

if (-not $env:SESSION_SECRET) {
    $env:SESSION_SECRET = node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))"
}

Write-Host "Starting RewardHub locally. Open http://localhost:3000 in your browser." -ForegroundColor Green
Write-Host "Press Ctrl+C here to stop the server." -ForegroundColor Yellow
npm start
