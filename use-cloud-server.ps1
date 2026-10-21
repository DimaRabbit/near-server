# Переключает NEAR на постоянный облачный сервер Render.
# Все клиенты (ты, телефон, другой город) коннектятся сюда — без cloudflared.

$ErrorActionPreference = "Stop"
$ServerDir = $PSScriptRoot
$CloudHost = "near-server.onrender.com"
$DiscoverFile = Join-Path $ServerDir "CURRENT_HOST.txt"

$env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
            [System.Environment]::GetEnvironmentVariable("Path", "User")

Write-Host "Проверяю https://$CloudHost/ (cold start Render может занять 30-60с)..."
$body = $null
for ($i = 1; $i -le 6; $i++) {
    $body = curl.exe -sS --max-time 45 "https://$CloudHost/" 2>$null
    if ($body -match "NEAR") { break }
    Write-Host "  attempt $i/6 (ждём просыпания Render)..."
    Start-Sleep -Seconds 5
}
if ($body -notmatch "NEAR") {
    throw "Render не ответил. Открой dashboard.render.com и убедись что near-server задеплоен/не crashed."
}
Write-Host "OK: $body" -ForegroundColor Green

Set-Content -Path $DiscoverFile -Value $CloudHost -NoNewline
Set-Content -Path (Join-Path $ServerDir "CURRENT_TUNNEL_HOST.txt") -Value $CloudHost -NoNewline

Write-Host "Публикую CURRENT_HOST.txt → GitHub..."
Push-Location $ServerDir
try {
    git add CURRENT_HOST.txt
    if (git status --porcelain CURRENT_HOST.txt) {
        git -c user.email="near-prototype@local" -c user.name="near-prototype" `
            commit -m "chore: use Render cloud host for multiplayer" 2>&1 | Out-Host
        git push origin HEAD 2>&1 | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "git push failed" }
    }
    Write-Host "GitHub OK: клиенты возьмут $CloudHost" -ForegroundColor Green
} finally {
    Pop-Location
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host " Облако: $CloudHost"
Write-Host " 1) НЕ запускай Start NEAR Server.bat (localhost отрежет тебя от друзей)"
Write-Host " 2) В игре на своём ПК тоже Guest/Play — зайдёшь в тот же облачный сервер"
Write-Host " 3) Друг/Android — то же самое"
Write-Host " Первое подключение после сна Render: 20-60 сек"
Write-Host "========================================" -ForegroundColor Green
