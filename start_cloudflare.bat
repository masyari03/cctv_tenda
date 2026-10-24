@echo off
title Cloudflare Tunnel - Tenda CH9 CCTV Server
color 0a
echo ========================================================
echo   MENGHUBUNGKAN TENDA CH9 CCTV SERVER KE CLOUDFLARE
echo ========================================================
echo.
cd /d "%~dp0"
echo Membuka tunnel publik HTTPS untuk http://localhost:3080 ...
echo Simpan link URL *.trycloudflare.com yang muncul di bawah ini:
echo.
cloudflared.exe tunnel --url http://localhost:3080
pause
