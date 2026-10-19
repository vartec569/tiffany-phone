@echo off
REM Tiffany Phone v2 - start server (Option A Minimal UI)
REM Pastikan Antigravity sudah jalan dengan --remote-debugging-port=9000 DULU.

cd /d "%~dp0"

if not exist node_modules (
    echo Installing dependencies...
    call npm install
)

REM Password & token disimpan di file lokal (.tp-pass / .tp-token) biar
REM restart tidak perlu ketik ulang. Hapus file-nya kalau mau ganti.
if "%APP_PASSWORD%"=="" (
    if exist ".tp-pass" (
        set /p APP_PASSWORD=<".tp-pass"
        echo (password tersimpan dipakai)
    ) else (
        set /p APP_PASSWORD=Masukkan password HP [disimpan utk restart berikutnya]:
        call :savevar APP_PASSWORD ".tp-pass"
    )
)

if "%TIFFANY_TOKEN%"=="" (
    if exist ".tp-token" (
        set /p TIFFANY_TOKEN=<".tp-token"
        echo (token Tiffany tersimpan dipakai)
    ) else (
        set /p TIFFANY_TOKEN=Masukkan token Tiffany [kosongkan = API nonaktif]:
        if not "%TIFFANY_TOKEN%"=="" call :savevar TIFFANY_TOKEN ".tp-token"
    )
)

echo.
echo Starting Tiffany Phone v2...
echo Buka di HP via Tailscale: http://100.81.74.82:3001
echo.
call node server.js
echo.
echo [Server berhenti - kode: %errorlevel%]
pause
goto :eof

:savevar
REM %1 = nama variable, %2 = file target. Tulis value tanpa spasi ekstra.
setlocal EnableDelayedExpansion
set "_v=!%1!"
>"%2" echo(!_v!
endlocal
goto :eof
