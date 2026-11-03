@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0" || goto failed
set "SSQ_NODE=node.exe"
where node.exe >nul 2>&1
if not errorlevel 1 goto run
set "SSQ_NODE=%ProgramFiles%\nodejs\node.exe"
if exist "%SSQ_NODE%" goto run
set "SSQ_NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if exist "%SSQ_NODE%" goto run
echo Node.js 22 or later was not found. Please install it, then try again.
goto failed

:run
"%SSQ_NODE%" "%~dp0scripts\start.mjs"
if errorlevel 1 goto failed
exit /b 0

:failed
echo.
echo Startup failed. Keep this window open to read the error above.
pause
exit /b 1
