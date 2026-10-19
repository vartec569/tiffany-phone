@echo off
REM Tiffany Phone v2 - start server (Option A Minimal UI)
REM Pastikan Antigravity sudah jalan dengan --remote-debugging-port=9000 DULU.

cd /d "%~dp0"

if not exist node_modules (
    echo Installing dependencies...
    call npm install
)

REM Password HP: kalau belum ada, dibuat otomatis yang gampang dibaca.
REM Selalu ditampilkan di bawah biar tinggal copy ke HP.
if exist ".tp-pass" goto havepass
set /a _pwnum=%RANDOM% * 9000 / 32768 + 1000
echo tiffany-%_pwnum%>.tp-pass
:havepass
set /p APP_PASSWORD=<".tp-pass"

if not "%TIFFANY_TOKEN%"=="" goto havetok
if exist ".tp-token" (
    set /p TIFFANY_TOKEN=<".tp-token"
) else (
    set /p TIFFANY_TOKEN=Masukkan token Tiffany, kosongkan = API nonaktif:
)
:havetok
if not "%TIFFANY_TOKEN%"=="" echo %TIFFANY_TOKEN%>.tp-token

if "%APP_PASSWORD%"=="" (
    echo ERROR: password masih kosong.
    pause
    exit /b 1
)

echo.
echo ==================================================
echo  PASSWORD BUAT LOGIN DARI HP:
echo.
echo    %APP_PASSWORD%
echo.
echo  Copy password di atas, paste di HP.
echo ==================================================
echo.
echo Starting Tiffany Phone v2...
echo Buka di HP via Tailscale: http://100.81.74.82:3001
echo.
call node server.js
echo.
echo [Server berhenti - kode: %errorlevel%]
pause
