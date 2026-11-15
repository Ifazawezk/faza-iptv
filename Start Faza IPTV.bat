@echo off
title Faza IPTV
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get it free from https://nodejs.org and run this again. & pause & exit /b)
node server.js --open
pause
