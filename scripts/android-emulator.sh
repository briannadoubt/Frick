#!/bin/sh
set -eu

AVD_NAME="${AVD_NAME:-frick_api_36}"
ANDROID_HOME="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"
ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$ANDROID_HOME}"
JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home}"
PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
SCREEN_NAME="${SCREEN_NAME:-frick-android-emulator}"
LOG_FILE="${LOG_FILE:-/tmp/frick-android-emulator.log}"
AVD_DIR="$HOME/.android/avd/$AVD_NAME.avd"

export ANDROID_HOME ANDROID_SDK_ROOT JAVA_HOME PATH

if ! command -v screen >/dev/null 2>&1; then
  echo "screen is required to keep the emulator detached" >&2
  exit 1
fi

kill_existing_emulators() {
  adb start-server >/dev/null 2>&1 || true
  adb devices | awk '/^emulator-/ {print $1}' | while read -r serial; do
    if [ -n "$serial" ]; then
      adb -s "$serial" emu kill >/dev/null 2>&1 || true
    fi
  done
  pkill -f "qemu-system-aarch64.*-avd $AVD_NAME" >/dev/null 2>&1 || true

  attempt=0
  while [ "$attempt" -lt 20 ]; do
    if [ -z "$(adb devices | awk '/^emulator-/ {print $1}')" ]; then
      return
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
}

screen -S "$SCREEN_NAME" -X quit >/dev/null 2>&1 || true
kill_existing_emulators
adb kill-server >/dev/null 2>&1 || true

if [ -d "$AVD_DIR" ]; then
  find "$AVD_DIR" -name '*.lock' -delete
  if [ -f "$AVD_DIR/config.ini" ]; then
    if grep -q '^hw.keyboard=' "$AVD_DIR/config.ini"; then
      sed -i.bak 's/^hw.keyboard=.*/hw.keyboard=yes/' "$AVD_DIR/config.ini"
    else
      printf '\nhw.keyboard=yes\n' >> "$AVD_DIR/config.ini"
    fi
  fi
fi

adb start-server >/dev/null
screen -dmS "$SCREEN_NAME" sh -lc "export ANDROID_HOME='$ANDROID_HOME' ANDROID_SDK_ROOT='$ANDROID_SDK_ROOT' JAVA_HOME='$JAVA_HOME' PATH='$PATH'; emulator -avd '$AVD_NAME' -no-window -no-audio -no-boot-anim -no-snapshot-load -no-snapshot-save -gpu swiftshader_indirect > '$LOG_FILE' 2>&1"

adb wait-for-device
while [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" != "1" ]; do
  sleep 2
done

adb shell settings put secure show_ime_with_hard_keyboard 1 >/dev/null 2>&1 || true
adb devices -l
