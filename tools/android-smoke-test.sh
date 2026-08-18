#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
gradle_cmd="${GRADLE_COMMAND:-$project_root/gradlew}"
sdk_root="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"

if [[ ! -x "$gradle_cmd" ]]; then
  echo "Gradle wrapper not found or not executable: $gradle_cmd" >&2
  exit 1
fi
if [[ -z "$sdk_root" || ! -d "$sdk_root" ]]; then
  echo "ANDROID_SDK_ROOT or ANDROID_HOME is required" >&2
  exit 1
fi

if [[ "${READLINGO_SKIP_GRADLE_BUILD:-0}" != "1" ]]; then
  "$gradle_cmd" --no-daemon --stacktrace assembleDebug
fi

apk="$project_root/app/build/outputs/apk/debug/app-debug.apk"
if [[ ! -f "$apk" ]]; then
  echo "Debug APK not found: $apk" >&2
  exit 1
fi

find_tool() {
  local name="$1"
  local candidate
  for candidate in \
    "$sdk_root/build-tools/34.0.0/$name" \
    "$sdk_root/build-tools/34.0.0-rc1/$name" \
    "$sdk_root/android-14/$name"; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

aapt2="$(find_tool aapt2)"
zipalign="$(find_tool zipalign)"
apksigner="$(find_tool apksigner)"

"$aapt2" dump badging "$apk" | grep -Eq "package: name='com.readlingo.app'"
unzip -l "$apk" | grep -Eq 'assets/index\.html'
unzip -l "$apk" | grep -Eq 'assets/js/app\.js'
unzip -l "$apk" | grep -Eq 'assets/css/style\.css'
"$zipalign" -c -p 4 "$apk"
"$apksigner" verify --verbose "$apk" >/dev/null

echo "Android smoke test passed: $apk"
