@echo off
title DUGate Dev Launcher
cd /d "%~dp0\.."
powershell.exe -ExecutionPolicy Bypass -File "%~dp0start-all.ps1"
pause
