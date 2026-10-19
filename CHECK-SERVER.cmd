@echo off
setlocal
cd /d "%~dp0"
set BENDING_HOST=0.0.0.0
set BENDING_PORT=8765
echo Checking server startup. Please wait...
echo === Windows === > diagnostic.txt
ver >> diagnostic.txt
echo Architecture: %PROCESSOR_ARCHITECTURE% >> diagnostic.txt
echo Folder: %CD% >> diagnostic.txt
if not exist "runtime\python.exe" (
  echo ERROR: runtime\python.exe is missing. Extract the entire ZIP first. >> diagnostic.txt
  goto result
)
echo === Python === >> diagnostic.txt
"runtime\python.exe" -I -c "import sys,sqlite3; print(sys.version); import pypdfium2; from PIL import Image; print('PDF libraries OK')" >> diagnostic.txt 2>&1
if errorlevel 1 goto result
echo === Network === >> diagnostic.txt
ipconfig >> diagnostic.txt 2>&1
netstat -ano -p tcp | findstr :8765 >> diagnostic.txt 2>&1
echo === HTTP check === >> diagnostic.txt
"runtime\python.exe" -I -c "import urllib.request; r=urllib.request.urlopen('http://127.0.0.1:8765/api/orders',timeout=3); print('Local server HTTP:',r.status)" >> diagnostic.txt 2>&1
if not errorlevel 1 goto result
echo === Starting server; errors are written below === >> diagnostic.txt
echo Starting server in this window. If it stays running, try http://127.0.0.1:8765
echo If it works, press Ctrl+C to stop this diagnostic server.
"runtime\python.exe" -I "server.py" >> diagnostic.txt 2>&1
:result
type diagnostic.txt
echo.
echo Diagnostic saved to diagnostic.txt. Send its contents for troubleshooting.
pause
