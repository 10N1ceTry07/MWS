@echo off
set BENDING_HOST=0.0.0.0
set BENDING_PORT=8765
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
if errorlevel 1 pause
