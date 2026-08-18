#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
output_dir="${READLINGO_OUTPUT_DIR:-$project_root/build/release}"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/readlingo-build.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT

find_file() {
  local candidate
  for candidate in "$@"; do
    if [[ -f "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

find_tool_dir() {
  local candidate
  for candidate in "$@"; do
    if [[ -x "$candidate/aapt2" && -x "$candidate/d8" && -x "$candidate/zipalign" && -x "$candidate/apksigner" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

sdk_root="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"
if [[ -z "$sdk_root" ]]; then
  echo "ANDROID_SDK_ROOT or ANDROID_HOME is required" >&2
  exit 1
fi

platform_jar="${READLINGO_PLATFORM_JAR:-}"
if [[ -z "$platform_jar" ]]; then
  platform_jar="$(find_file \
    "$sdk_root/platforms/android-34/android.jar" \
    "$sdk_root/android-34/android.jar" || true)"
fi

build_tools="${READLINGO_BUILD_TOOLS:-}"
if [[ -z "$build_tools" ]]; then
  build_tools="$(find_tool_dir \
    "$sdk_root/build-tools/34.0.0" \
    "$sdk_root/build-tools/34.0.0-rc1" \
    "$sdk_root/android-14" || true)"
fi

if [[ -z "$platform_jar" || ! -f "$platform_jar" ]]; then
  echo "Android 34 android.jar not found; set READLINGO_PLATFORM_JAR" >&2
  exit 1
fi
if [[ -z "$build_tools" ]]; then
  echo "aapt2/d8/zipalign/apksigner not found; set READLINGO_BUILD_TOOLS" >&2
  exit 1
fi

command -v javac >/dev/null || { echo "javac is required" >&2; exit 1; }
command -v keytool >/dev/null || { echo "keytool is required" >&2; exit 1; }
command -v zip >/dev/null || { echo "zip is required" >&2; exit 1; }

mkdir -p "$work_dir/gen" "$work_dir/classes" "$work_dir/dex" "$work_dir/assets" "$output_dir"

# Gradle gets the namespace from app/build.gradle, while the legacy direct
# aapt2 path still needs a package attribute in the manifest. Add it only to
# the temporary manifest so the source stays valid for a standard Gradle
# Android project.
manifest_file="$work_dir/AndroidManifest.xml"
sed 's#<manifest xmlns:android=#<manifest package="com.readlingo.app" xmlns:android=#' \
  "$project_root/app/src/main/AndroidManifest.xml" > "$manifest_file"

"$build_tools/aapt2" compile \
  --dir "$project_root/app/src/main/res" \
  -o "$work_dir/res.zip"

"$build_tools/aapt2" link \
  -o "$work_dir/base.apk" \
  -I "$platform_jar" \
  --manifest "$manifest_file" \
  --min-sdk-version 26 \
  --target-sdk-version 34 \
  --version-code 1 \
  --version-name 0.1.0 \
  -R "$work_dir/res.zip" \
  --auto-add-overlay \
  --java "$work_dir/gen"

mapfile -t java_sources < <(find "$project_root/app/src/main/java" -type f -name '*.java' -print | sort)
if [[ "${#java_sources[@]}" -eq 0 ]]; then
  echo "No Java sources found" >&2
  exit 1
fi
javac -source 8 -target 8 -cp "$platform_jar" -d "$work_dir/classes" "${java_sources[@]}"

mapfile -t class_files < <(find "$work_dir/classes" -type f -name '*.class' -print | sort)
if [[ "${#class_files[@]}" -eq 0 ]]; then
  echo "No compiled classes found" >&2
  exit 1
fi
"$build_tools/d8" --lib "$platform_jar" --output "$work_dir/dex" "${class_files[@]}"

cp -a "$project_root/app/src/main/assets/." "$work_dir/assets/"
cp "$work_dir/dex/classes.dex" "$work_dir/classes.dex"
cp "$work_dir/base.apk" "$work_dir/unsigned.apk"
(cd "$work_dir" && zip -qr "$work_dir/unsigned.apk" assets classes.dex)
"$build_tools/zipalign" -f -p 4 "$work_dir/unsigned.apk" "$work_dir/aligned.apk"

if [[ -n "${READLINGO_KEYSTORE:-}" ]]; then
  keystore="$READLINGO_KEYSTORE"
  key_alias="${READLINGO_KEY_ALIAS:?READLINGO_KEY_ALIAS is required with READLINGO_KEYSTORE}"
  keystore_password="${READLINGO_KEYSTORE_PASSWORD:?READLINGO_KEYSTORE_PASSWORD is required with READLINGO_KEYSTORE}"
  key_password="${READLINGO_KEY_PASSWORD:-$keystore_password}"
else
  keystore="$project_root/build/readlingo-debug.keystore"
  key_alias="readlingo"
  keystore_password="android"
  key_password="android"
  if [[ ! -f "$keystore" ]]; then
    mkdir -p "$(dirname "$keystore")"
    keytool -genkeypair \
      -keystore "$keystore" \
      -storetype PKCS12 \
      -alias "$key_alias" \
      -storepass "$keystore_password" \
      -keypass "$key_password" \
      -keyalg RSA \
      -keysize 2048 \
      -validity 10000 \
      -dname "CN=ReadLingo Debug, OU=Dev, O=ReadLingo, L=Local, ST=Local, C=CN" \
      >/dev/null 2>&1
  fi
fi

if [[ ! -f "$keystore" ]]; then
  echo "Keystore not found: $keystore" >&2
  exit 1
fi

"$build_tools/apksigner" sign \
  --ks "$keystore" \
  --ks-key-alias "$key_alias" \
  --ks-pass "pass:$keystore_password" \
  --key-pass "pass:$key_password" \
  --out "$output_dir/readlingo.apk" \
  "$work_dir/aligned.apk"

"$build_tools/apksigner" verify "$output_dir/readlingo.apk"
echo "Built: $output_dir/readlingo.apk"
