@echo off
REM Tiffany Phone v2 - start server (Option A Minimal UI)
REM Pastikan Antigravity sudah jalan dengan --remote-debugging-port=9000 DULU.

cd /d "%~dp0"

if not exist node_modules (
    echo Installing dependencies...
    call npm install
)

if "%APP_PASSWORD%"=="" (
    set /p APP_PASSWORD=Masukkan password HP:
)

if "%TIFFANY_TOKEN%"=="" (
    set /p TIFFANY_TOKEN=Masukkan token Tiffany (kosongkan = API Tiffany nonaktif):
)

echo.
echo Starting Tiffany Phone v2...
echo Buka di HP via Tailscale: http://100.81.74.82:3001
echo.
node server.js
pause
