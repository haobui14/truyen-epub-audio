@echo off
setlocal

echo ========================================
echo  Build Android Debug APK
echo ========================================

cd /d "%~dp0frontend"

echo.
echo [1/3] Building Next.js static export...
call pnpm build:cap
if errorlevel 1 (
    echo ERROR: Next.js build failed.
    pause
    exit /b 1
)

echo.
echo [2/3] Syncing Capacitor...
call npx cap sync android
if errorlevel 1 (
    echo ERROR: Capacitor sync failed.
    pause
    exit /b 1
)

echo.
echo [3/3] Building debug APK...
cd android
call gradlew.bat assembleDebug
if errorlevel 1 (
    echo ERROR: Gradle build failed.
    pause
    exit /b 1
)

echo.
echo ========================================
echo  BUILD SUCCESSFUL
echo  APK: frontend\android\app\build\outputs\apk\debug\app-debug.apk
echo ========================================
pause
