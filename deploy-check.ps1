# NEAR server deploy readiness check (no commit/push).
# Usage: powershell -ExecutionPolicy Bypass -File .\deploy-check.ps1

$ErrorActionPreference = "Continue"
$ServerDir = $PSScriptRoot
$CloudHost = "near-server.onrender.com"

Write-Host "=== NEAR server deploy check ===" -ForegroundColor Cyan
Write-Host "Dir: $ServerDir"

Write-Host ""
Write-Host "[1] Render health (cold start up to ~60s)..."
$body = $null
for ($i = 1; $i -le 8; $i++) {
    try {
        $r = Invoke-WebRequest -Uri "https://$CloudHost/" -UseBasicParsing -TimeoutSec 30
        $body = $r.Content
        if ($body -match "NEAR") { break }
    } catch {
        Write-Host "  attempt $i/8..."
        Start-Sleep -Seconds 5
    }
}
if ($body -match "NEAR") {
    Write-Host "OK: $body" -ForegroundColor Green
} else {
    Write-Host "FAIL: Render did not respond. Check dashboard.render.com" -ForegroundColor Red
}

Write-Host ""
Write-Host "[2] Local files"
@(
    "server.js",
    "sql\bulletin.sql",
    "sql\office_board.sql",
    "CURRENT_HOST.txt",
    "README.md"
) | ForEach-Object {
    $p = Join-Path $ServerDir $_
    if (Test-Path $p) { Write-Host "  OK  $_" -ForegroundColor Green }
    else { Write-Host "  MISSING $_" -ForegroundColor Red }
}

Write-Host ""
Write-Host "[3] Git (unpushed changes = old protocol on Render)"
Push-Location $ServerDir
try {
    git status -sb
    $dirty = git status --porcelain
    if ($dirty) {
        Write-Host ""
        Write-Host "Local changes present. To ship anim/skin/office/bulletin:" -ForegroundColor Yellow
        Write-Host '  git add server.js sql README.md .gitignore deploy-check.ps1'
        Write-Host '  git commit -m "feat: bulletin+office persist, skin/anim protocol"'
        Write-Host "  git push origin main"
        Write-Host "Then Render Auto-Deploy (or Manual Deploy)."
    } else {
        Write-Host "Working tree clean." -ForegroundColor Green
    }
} finally {
    Pop-Location
}

Write-Host ""
Write-Host "[4] Manual checklist"
Write-Host "  - Supabase SQL: bulletin.sql + office_board.sql"
Write-Host "  - Render env: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY"
Write-Host "  - After deploy logs: bulletin+office->Supabase"
Write-Host "  - CURRENT_HOST.txt = near-server.onrender.com"
Write-Host ""
Write-Host "Done." -ForegroundColor Cyan
