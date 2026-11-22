@echo off
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo First-time setup: creating virtual environment...
  py -3 -m venv .venv
  if errorlevel 1 goto :error
)
".venv\Scripts\python.exe" -c "import fastapi, dotenv; from google import genai" >nul 2>&1
if errorlevel 1 (
  echo Installing or updating project dependencies...
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt
  if errorlevel 1 goto :error
)
start "Emotional Simulator server" /B ".venv\Scripts\python.exe" -m uvicorn app.main:app --host 127.0.0.1 --port 8000
timeout /t 2 /nobreak >nul
start "Emotional Simulator" http://127.0.0.1:8000
echo The server is running. Close this window to stop it.
pause
goto :end
:error
echo Setup failed. Please install Python 3.11 or newer from https://www.python.org/downloads/windows/
pause
:end
endlocal
