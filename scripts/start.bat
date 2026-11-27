@echo off
rem ─────────────────────────────────────────────────────────────
rem  N-chat launcher (Windows)
rem  Reads paths from environment if set, otherwise uses defaults.
rem  Keep this file ASCII-only: cmd.exe reads .bat in the OEM
rem  codepage, non-ASCII lines get mangled on some systems.
rem ─────────────────────────────────────────────────────────────
chcp 65001 >nul
title N-chat
setlocal enabledelayedexpansion

rem Project root = parent of this script's folder
for %%I in ("%~dp0..") do set "NCHAT_HOME=%%~fI"
set "NCHAT_DATA=%NCHAT_HOME%\data"

if "%PROFILE%"=="" set "PROFILE=group"
if "%PORT%"=="" set "PORT=3090"
if "%WEB_PORT%"=="" set "WEB_PORT=4200"

rem Node: use NODE_EXE if given, else whatever is on PATH
if "%NODE_EXE%"=="" set "NODE_EXE=node"
where %NODE_EXE% >nul 2>&1
if errorlevel 1 (
  echo [ERR] node not found. Install Node.js 22+ or set NODE_EXE.
  pause
  exit /b 1
)

rem DSH entry: local install first, then DSH_BIN override
set "DSH_BIN=%NCHAT_HOME%\program\node_modules\@deepseek-ai\dsh\lib\bin.js"
if not exist "%DSH_BIN%" (
  if not "%DSH_CLI%"=="" set "DSH_BIN=%DSH_CLI%"
)
if not exist "%DSH_BIN%" (
  echo [ERR] DSH CLI not found.
  echo       expected: %NCHAT_HOME%\program\node_modules\@deepseek-ai\dsh\lib\bin.js
  echo       fix: npm i @deepseek-ai/dsh --prefix "%NCHAT_HOME%\program"
  echo       or set DSH_CLI to the full path of lib\bin.js
  pause
  exit /b 1
)

if not exist "%NCHAT_DATA%" mkdir "%NCHAT_DATA%"

echo ============================================
echo   N-chat   profile=%PROFILE%  port=%PORT%
echo ============================================
echo.

rem ── optional: Breeze TTS on port 8137 ────────────────────────
if not "%BREEZE_EXE%"=="" (
  echo [tts ] %BREEZE_EXE%
  netstat -ano | findstr ":8137" | findstr LISTENING >nul
  if errorlevel 1 (
    if exist "%BREEZE_EXE%" (
      start "N-chat-tts" /min "%BREEZE_EXE%" %BREEZE_ARGS%
    ) else (
      echo        SKIP - file not found
    )
  ) else (
    echo        already running
  )
) else (
  echo [tts ] skipped ^(set BREEZE_EXE + BREEZE_ARGS to enable^)
)

rem ── optional: drawing browser on port 9225 ───────────────────
if not "%PAINTER_DIR%"=="" (
  echo [draw] %PAINTER_DIR%
  netstat -ano | findstr ":9225" | findstr LISTENING >nul
  if errorlevel 1 (
    start "N-chat-paint" /min /d "%PAINTER_DIR%" %NODE_EXE% tools\start-web.mjs 9225
  ) else (
    echo        already running
  )
) else (
  echo [draw] skipped ^(set PAINTER_DIR to enable^)
)

rem ── core ─────────────────────────────────────────────────────
echo [core] starting, live log below. Close this window to stop.
echo --------------------------------------------
echo.

set "DSH_HOME=%NCHAT_DATA%"
set "NCHAT_HOME=%NCHAT_HOME%"

netstat -ano | findstr ":%PORT%" | findstr LISTENING >nul
if not errorlevel 1 (
  echo Core is already listening on %PORT% - just open http://127.0.0.1:%WEB_PORT%/
  pause
  exit /b 0
)

start "" "http://127.0.0.1:%WEB_PORT%/"
"%NODE_EXE%" "%DSH_BIN%" %PROFILE% --port %PORT% --no-open

echo.
echo ============================================
echo   Core exited.
echo ============================================
pause
exit /b 0
