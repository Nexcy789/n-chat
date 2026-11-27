@echo off
rem Build a release APK. Needs JDK 17 + Android SDK (ANDROID_HOME / ANDROID_SDK_ROOT).
rem Signing config comes from local.properties or environment, see android/app/build.gradle.kts
chcp 65001 >nul
setlocal

for %%I in ("%~dp0..") do set "NCHAT_HOME=%%~fI"
set "ANDROID_DIR=%NCHAT_HOME%\android"
set "OUT=%NCHAT_HOME%\dist"

if "%GRADLE%"=="" set "GRADLE=gradle"
where %GRADLE% >nul 2>&1
if errorlevel 1 (
  echo [ERR] gradle not found.
  echo       Easiest: open "%ANDROID_DIR%" in Android Studio and build there.
  echo       Or install Gradle 8+ and put it on PATH.
  pause
  exit /b 1
)

echo [1/3] sync frontend to assets
copy /Y "%NCHAT_HOME%\plugins\dsh-webchat\web\index.html" "%ANDROID_DIR%\app\src\main\assets\index.html" >nul
if errorlevel 1 (echo [ERR] copy failed & pause & exit /b 1)

echo [2/3] assembleRelease
call %GRADLE% -p "%ANDROID_DIR%" :app:assembleRelease --no-daemon --console=plain
if errorlevel 1 (echo. & echo [ERR] BUILD FAILED & pause & exit /b 1)

echo [3/3] copy output
if not exist "%OUT%" mkdir "%OUT%"
copy /Y "%ANDROID_DIR%\app\build\outputs\apk\release\app-release.apk" "%OUT%\N-chat.apk" >nul
if errorlevel 1 (
  echo [ERR] no signed apk produced - check NCHAT_KEYSTORE in local.properties
  pause
  exit /b 1
)

echo.
echo done: %OUT%\N-chat.apk
pause
