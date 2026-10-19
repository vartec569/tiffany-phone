@echo off
REM Tiffany Phone v2 - start server (Option A Minimal UI)
REM Pastikan Antigravity sudah jalan dengan --remote-debugging-port=9000 DULU.

cd /d "%~dp0"

if not exist node_modules (
    echo Installing dependencies...
    call npm install
)

REM Password & token: dipakai dari file kalau ada, kalau belum ada ditanya
REM sekali lalu disimpan. Hapus .tp-pass / .tp-token untuk ganti.
if not "%APP_PASSWORD%"=="" goto havepw
if exist ".tp-pass" (
    set /p APP_PASSWORD=<".tp-pass"
    echo password tersimpan dipakai
) else (
    set /p APP_PASSWORD=Masukkan password HP:
)
:havepw
if not "%APP_PASSWORD%"=="" echo %APP_PASSWORD%>.tp-pass

if not "%TIFFANY_TOKEN%"=="" goto havetok
if exist ".tp-token" (
    set /p TIFFANY_TOKEN=<".tp-token"
    echo token Tiffany tersimpan dipakai
) else (
    set /p TIFFANY_TOKEN=Masukkan token Tiffany, kosongkan = API nonaktif:
)
:havetok
if not "%TIFFANY_TOKEN%"=="" echo %TIFFANY_TOKEN%>.tp-token

if "%APP_PASSWORD%"=="" (
    echo ERROR: password masih kosong. Tutup window ini, buka lagi, lalu ketik password.
    pause
    exit /b 1
)

echo.
echo Starting Tiffany Phone v2...
echo Buka di HP via Tailscale: http://100.81.74.82:3001
echo.
call node server.js
echo.
echo [Server berhenti - kode: %errorlevel%]
pause
