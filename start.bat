@echo off
title Tenda CH9 CCTV Server (Drive D: 50GB Storage)
color 0b
echo ========================================================
echo   MENJALANKAN TENDA CH9 CCTV SERVER (DRIVE D 50GB)
echo ========================================================
echo.
cd /d "%~dp0"
node server.js
pause
