#!/usr/bin/env bash
set -euo pipefail

echo "========================================"
echo " Build Android Debug APK"
echo "========================================"

cd "$(dirname "$0")/frontend"

echo ""
echo "[1/3] Building Next.js static export..."
pnpm build:cap

echo ""
echo "[2/3] Syncing Capacitor..."
npx cap sync android

echo ""
echo "[3/3] Building debug APK..."
cd android
./gradlew assembleDebug

echo ""
echo "========================================"
echo " BUILD SUCCESSFUL"
echo " APK: frontend/android/app/build/outputs/apk/debug/app-debug.apk"
echo "========================================"
