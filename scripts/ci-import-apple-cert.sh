#!/usr/bin/env bash
# Import APPLE_CERTIFICATE (.p12, base64) into a temporary keychain for CI signing.
# Exit 0 on success; exit 1 if secrets look set but the PKCS#12 cannot be imported.
set -euo pipefail

if [[ -z "${APPLE_CERTIFICATE:-}" || -z "${APPLE_CERTIFICATE_PASSWORD:-}" ]]; then
  echo "APPLE_CERTIFICATE / APPLE_CERTIFICATE_PASSWORD not set; skip cert import"
  exit 0
fi

KEYCHAIN_PASSWORD="${KEYCHAIN_PASSWORD:-hghub-ci-keychain}"
KEYCHAIN="${RUNNER_TEMP:-/tmp}/hghub-build.keychain"
CERT_PATH="${RUNNER_TEMP:-/tmp}/hghub-certificate.p12"

# Decode; tolerate accidental whitespace / newlines in the secret.
echo "$APPLE_CERTIFICATE" | tr -d '\r\n\t ' | base64 --decode > "$CERT_PATH" 2>/dev/null || {
  echo "::warning::APPLE_CERTIFICATE is not valid base64; cannot import signing cert"
  rm -f "$CERT_PATH"
  exit 1
}

# PKCS#12 files typically start with an ASN.1 SEQUENCE (0x30). Reject empty / garbage early.
if [[ ! -s "$CERT_PATH" ]] || ! python3 -c 'import sys; d=open(sys.argv[1],"rb").read(4); sys.exit(0 if d[:1]==b"\x30" else 1)' "$CERT_PATH" 2>/dev/null; then
  echo "::warning::Decoded APPLE_CERTIFICATE is not a PKCS#12 blob (wrong secret / truncated / not a .p12)"
  rm -f "$CERT_PATH"
  exit 1
fi

security delete-keychain "$KEYCHAIN" 2>/dev/null || true
security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
security default-keychain -s "$KEYCHAIN"
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
security set-keychain-settings -t 3600 -u "$KEYCHAIN"

if ! security import "$CERT_PATH" -k "$KEYCHAIN" -P "$APPLE_CERTIFICATE_PASSWORD" \
  -T /usr/bin/codesign -T /usr/bin/security -T /usr/bin/productbuild; then
  echo "::warning::security import failed (bad password or corrupt .p12); signing cert unavailable"
  rm -f "$CERT_PATH"
  security delete-keychain "$KEYCHAIN" 2>/dev/null || true
  exit 1
fi

security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
security list-keychains -d user -s "$KEYCHAIN" $(security list-keychains -d user | sed 's/"//g')
security find-identity -v -p codesigning "$KEYCHAIN"

# Prefer an explicit identity; otherwise pick the first codesigning identity.
if [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  IDENTITY="$(security find-identity -v -p codesigning "$KEYCHAIN" | awk -F'"' '/\"/{print $2; exit}')"
  if [[ -n "$IDENTITY" ]]; then
    echo "APPLE_SIGNING_IDENTITY=$IDENTITY" >> "${GITHUB_ENV:-/dev/null}"
    export APPLE_SIGNING_IDENTITY="$IDENTITY"
    echo "Inferred signing identity: $IDENTITY"
  else
    echo "::warning::Certificate imported but no codesigning identity found in keychain"
    rm -f "$CERT_PATH"
    exit 1
  fi
fi

rm -f "$CERT_PATH"
echo "Apple certificate imported"
