@echo off
rem Stop everything N-chat started. ASCII-only, see start.bat.
chcp 65001 >nul
title Stop N-chat
setlocal enabledelayedexpansion

if "%PORT%"=="" set "PORT=3090"
if "%WEB_PORT%"=="" set "WEB_PORT=4200"
if "%DRAW_PORT%"=="" set "DRAW_PORT=9225"

set "COUNT=0"

call :killport "DSH core" %PORT%
call :killport "chat page" %WEB_PORT%
call :killport "draw browser" %DRAW_PORT%

echo [tts ] breeze-server
tasklist /FI "IMAGENAME eq breeze-server.exe" 2>nul | findstr /I "breeze-server" >nul
if not errorlevel 1 (
  taskkill /F /IM breeze-server.exe >nul 2>&1
  echo        killed
  set /a COUNT+=1
) else (
  echo        not running
)

echo.
echo --------------------------------------------
if "!COUNT!"=="0" (
  echo   Nothing was running.
) else (
  echo   Stopped !COUNT! process group^(s^).
)
echo --------------------------------------------
exit /b 0

:killport
set "HITS=0"
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%~2" ^| findstr LISTENING') do (
  taskkill /F /PID %%a >nul 2>&1
  echo [port] %~1 :%~2 - killed PID %%a
  set /a HITS+=1
  set /a COUNT+=1
)
if "!HITS!"=="0" echo [port] %~1 :%~2 - not running
exit /b 0
