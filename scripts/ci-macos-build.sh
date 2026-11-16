#!/usr/bin/env bash
# Build macOS universal app: Developer ID + notarize when secrets exist, else ad-hoc.
# Bad PKCS#12 / empty Team ID must never fail the job — fall back to ad-hoc.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CFG="$ROOT/src-tauri/tauri.macos.conf.json"
KEYCHAIN="${RUNNER_TEMP:-/tmp}/hghub-build.keychain"

# Strip every Apple credential Tauri might use for import / notarize.
strip_apple_env() {
  env -u APPLE_CERTIFICATE \
      -u APPLE_CERTIFICATE_PASSWORD \
      -u APPLE_SIGNING_IDENTITY \
      -u APPLE_ID \
      -u APPLE_PASSWORD \
      -u APPLE_TEAM_ID \
      -u APPLE_API_KEY \
      -u APPLE_API_ISSUER \
      -u APPLE_API_KEY_PATH \
      -u APPLE_API_KEY_BASE64 \
      "$@"
}

run_tauri_build() {
  local config="$1"
  strip_apple_env pnpm tauri build --config "$config" --target universal-apple-darwin
}

build_adhoc() {
  echo "::warning::Building ad-hoc signed macOS app (no usable Developer ID / notarization)"
  unset APPLE_SIGNING_IDENTITY || true
  # Force ad-hoc identity + notarize off even if workflow env still has Apple secrets.
  TMP="$(mktemp)"
  node -e '
    const fs=require("fs");
    const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    j.bundle=j.bundle||{};
    j.bundle.macOS=j.bundle.macOS||{};
    j.bundle.macOS.signingIdentity="-";
    j.bundle.macOS.notarize=false;
    fs.writeFileSync(process.argv[2], JSON.stringify(j,null,2)+"\n");
  ' "$CFG" "$TMP"
  run_tauri_build "$TMP"
  rm -f "$TMP"
}

HAS_CERT=0
TEAM_OK=0
if [[ -n "${APPLE_TEAM_ID:-}" && "${#APPLE_TEAM_ID}" -ge 3 ]]; then
  TEAM_OK=1
fi

if [[ -n "${APPLE_CERTIFICATE:-}" && -n "${APPLE_CERTIFICATE_PASSWORD:-}" ]]; then
  if bash scripts/ci-import-apple-cert.sh; then
    HAS_CERT=1
    if [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
      APPLE_SIGNING_IDENTITY="$(security find-identity -v -p codesigning "$KEYCHAIN" 2>/dev/null | awk -F'"' '/\"/{print $2; exit}')"
      export APPLE_SIGNING_IDENTITY
    fi
    if [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
      echo "::warning::No codesigning identity after import; falling back to ad-hoc"
      HAS_CERT=0
    else
      echo "Using signing identity: $APPLE_SIGNING_IDENTITY"
    fi
  else
    echo "::warning::Apple certificate import failed; falling back to ad-hoc signing"
    HAS_CERT=0
  fi
fi

if [[ "$HAS_CERT" -eq 1 ]]; then
  export APPLE_SIGNING_IDENTITY
  TMP="$(mktemp)"
  WANT_NOTARIZE=0
  if [[ "$TEAM_OK" -eq 1 && ( -n "${APPLE_API_KEY:-}" || ( -n "${APPLE_ID:-}" && -n "${APPLE_PASSWORD:-}" ) ) ]]; then
    WANT_NOTARIZE=1
  fi
  node -e '
    const fs=require("fs");
    const id=process.env.APPLE_SIGNING_IDENTITY||"";
    const notarize=process.argv[3]==="1";
    const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    j.bundle=j.bundle||{};
    j.bundle.macOS=j.bundle.macOS||{};
    if (id) j.bundle.macOS.signingIdentity=id; else delete j.bundle.macOS.signingIdentity;
    j.bundle.macOS.notarize=notarize;
    fs.writeFileSync(process.argv[2], JSON.stringify(j,null,2)+"\n");
  ' "$CFG" "$TMP" "$WANT_NOTARIZE"

  # Keep APPLE_TEAM_ID only when notarizing; always strip PKCS#12 to avoid a second import.
  if [[ "$WANT_NOTARIZE" -eq 1 ]]; then
    BUILD_ENV=(env -u APPLE_CERTIFICATE -u APPLE_CERTIFICATE_PASSWORD)
  else
    BUILD_ENV=(strip_apple_env)
  fi
  if ! "${BUILD_ENV[@]}" pnpm tauri build --config "$TMP" --target universal-apple-darwin; then
    echo "::warning::Developer ID / notarize build failed; falling back to ad-hoc"
    rm -f "$TMP"
    HAS_CERT=0
    build_adhoc
  else
    rm -f "$TMP"
  fi
else
  build_adhoc
fi

APP="$(find src-tauri/target/universal-apple-darwin/release/bundle -name 'HGhub.app' -type d | head -1 || true)"
if [[ -n "$APP" ]]; then
  if [[ "$HAS_CERT" -eq 0 ]]; then
    codesign --force --deep --options runtime --sign - "$APP" || true
  fi
  codesign -dv --verbose=2 "$APP" || true
fi
