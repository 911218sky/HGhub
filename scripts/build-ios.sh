#!/usr/bin/env bash
# Build iOS IPA. Signs when APPLE_TEAM_ID (+ optional cert) is present; otherwise unsigned.
set -euo pipefail

VERSION="${1:?Usage: build-ios.sh VERSION}"
ROOT="$(pwd)"
LOG="$ROOT/ios-build-session.log"
ADDR_FILE="$(node -p "require('os').tmpdir() + '/' + require('./src-tauri/tauri.conf.json').identifier + '-server-addr'")"
mkdir -p artifacts
rm -f "$ADDR_FILE"

SIGNED=0
if [[ -n "${APPLE_TEAM_ID:-}" ]]; then
  SIGNED=1
  if [[ -n "${APPLE_CERTIFICATE:-}" && -n "${APPLE_CERTIFICATE_PASSWORD:-}" ]]; then
    # Invalid PKCS#12 must not abort the IPA build — fall through unsigned-capable path.
    if ! bash scripts/ci-import-apple-cert.sh; then
      echo "::warning::Apple certificate import failed; continuing without codesign cert"
    fi
  fi
  export APPLE_DEVELOPMENT_TEAM="$APPLE_TEAM_ID"
else
  # `tauri ios build` requires a non-empty development team even for unsigned CI builds.
  export APPLE_DEVELOPMENT_TEAM="${APPLE_DEVELOPMENT_TEAM:-XXXXXXXXXX}"
  echo "::warning::No APPLE_TEAM_ID; using placeholder development team for tauri ios build (unsigned IPA)"
fi

# Keep tauri.ios.conf.json in sync — env alone is not always enough for --ci.
node -e '
  const fs=require("fs");
  const p="src-tauri/tauri.ios.conf.json";
  const j=JSON.parse(fs.readFileSync(p,"utf8"));
  j.bundle=j.bundle||{};
  j.bundle.iOS=j.bundle.iOS||{};
  j.bundle.iOS.developmentTeam=process.env.APPLE_DEVELOPMENT_TEAM;
  fs.writeFileSync(p, JSON.stringify(j,null,2)+"\n");
'

pnpm tauri ios build --open --ci --features custom-protocol >"$LOG" 2>&1 &
SESSION_PID=$!
cleanup() {
  kill "$SESSION_PID" 2>/dev/null || true
  cat "$LOG"
}
trap cleanup EXIT

for ((attempt = 0; attempt < 600; attempt++)); do
  if ! kill -0 "$SESSION_PID" 2>/dev/null; then
    echo 'Tauri build session exited before becoming ready' >&2
    exit 1
  fi
  if [[ -s "$ADDR_FILE" ]]; then
    break
  fi
  sleep 1
done
if [[ ! -s "$ADDR_FILE" ]]; then
  echo "Timed out waiting for the Tauri build options server ($ADDR_FILE)" >&2
  exit 1
fi

XCODE_TOOLCHAIN="$(xcode-select -p)/Toolchains/XcodeDefault.xctoolchain"
test -d "$XCODE_TOOLCHAIN/usr/lib/swift/iphoneos"

XB=(
  xcodebuild build
  -toolchain com.apple.dt.toolchain.XcodeDefault
  -project src-tauri/gen/apple/huangguo-client.xcodeproj
  -scheme huangguo-client_iOS
  -configuration release
  -sdk iphoneos
  -destination 'generic/platform=iOS'
  -derivedDataPath "$ROOT/build_output"
  TOOLCHAIN_DIR="$XCODE_TOOLCHAIN"
)

if [[ "$SIGNED" -eq 1 ]]; then
  echo "Building signed iOS app with team $APPLE_TEAM_ID"
  XB+=(
    DEVELOPMENT_TEAM="$APPLE_TEAM_ID"
    CODE_SIGN_STYLE=Automatic
    CODE_SIGNING_ALLOWED=YES
  )
else
  echo "::warning::No APPLE_TEAM_ID; building unsigned iOS IPA (sideload / TrollStore only)"
  XB+=(
    CODE_SIGNING_ALLOWED=NO
    CODE_SIGNING_REQUIRED=NO
    CODE_SIGN_IDENTITY=""
  )
fi

"${XB[@]}"

APP="$ROOT/build_output/Build/Products/release-iphoneos/HGhub.app"
EXECUTABLE=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Info.plist")
test -s "$APP/$EXECUTABLE"
file "$APP/$EXECUTABLE" | grep 'Mach-O.*arm64'
strings "$APP/$EXECUTABLE" > "$ROOT/ios-binary-strings.txt"
if grep -F 'localhost:1420' "$ROOT/ios-binary-strings.txt"; then
  echo 'Refusing to package a development build' >&2
  exit 1
fi

PACKAGE_DIR=$(mktemp -d)
mkdir -p "$PACKAGE_DIR/Payload"
cp -R "$APP" "$PACKAGE_DIR/Payload/"
if [[ "$SIGNED" -eq 1 ]]; then
  IPA="$ROOT/artifacts/HGhub_${VERSION}_ios.ipa"
else
  IPA="$ROOT/artifacts/HGhub_${VERSION}_ios-unsigned.ipa"
fi
(cd "$PACKAGE_DIR" && zip -qr "$IPA" Payload)
unzip -tq "$IPA"
ls -lh "$IPA"
