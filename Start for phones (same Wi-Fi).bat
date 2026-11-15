@echo off
title IPTV Player - phone mode
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get it free from https://nodejs.org and run this again. & pause & exit /b)
echo If Windows asks about the firewall, allow "Private networks" so your phone can connect.
node server.js --lan --open
pause
