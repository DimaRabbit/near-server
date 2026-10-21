@echo off
title NEAR Cloud Server (Render)
cd /d "%~dp0"
echo.
echo === NEAR: облачный сервер (другой город / Android) ===
echo Хост: near-server.onrender.com
echo Туннель Cloudflare больше НЕ нужен.
echo.
pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0use-cloud-server.ps1"
if errorlevel 1 (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0use-cloud-server.ps1"
)
echo.
pause
