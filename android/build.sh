#!/usr/bin/env bash
# Builds the Android APK with Apache Cordova. Needs: Node, Java 17, Android SDK, Gradle.
# GitHub Actions runs this automatically (see .github/workflows/build.yml).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$ROOT/android/.build"
VERSION="$(node -p "require('$ROOT/package.json').version")"

rm -rf "$WORK"
npx --yes cordova@12.0.0 create "$WORK" io.github.iptvplayer.app "IPTV Player"
sed "s/version=\"1.0.0\"/version=\"$VERSION\"/" "$ROOT/android/config.xml" > "$WORK/config.xml"
rm -rf "$WORK/www"
cp -r "$ROOT/public" "$WORK/www"
mkdir -p "$WORK/res"
cp "$ROOT/build/icon.png" "$WORK/res/icon.png"

cd "$WORK"
npx --yes cordova@12.0.0 platform add android@13.0.0
npx --yes cordova@12.0.0 build android --debug

mkdir -p "$ROOT/dist"
cp platforms/android/app/build/outputs/apk/debug/app-debug.apk "$ROOT/dist/IPTV-Player-$VERSION-android.apk"
echo "APK: $ROOT/dist/IPTV-Player-$VERSION-android.apk"
