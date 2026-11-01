#!/usr/bin/env bash
# ينزّل مكتبة التعرف على الوجه ونماذجها داخل التطبيق حتى يعمل بدون إنترنت.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WWW="$ROOT/app/src/main/assets/www"
TMP="$(mktemp -d)"
cd "$TMP"
npm init -y >/dev/null
npm install --no-audit --no-fund @vladmandic/face-api@1 jsqr@1 >/dev/null
PKG="$TMP/node_modules/@vladmandic/face-api"
mkdir -p "$WWW/lib" "$WWW/models"
cp "$PKG/dist/face-api.js" "$WWW/lib/face-api.js"
cp "$TMP/node_modules/jsqr/dist/jsQR.js" "$WWW/lib/jsQR.js"
for m in tiny_face_detector_model face_landmark_68_model face_recognition_model; do
  cp "$PKG/model/$m".* "$WWW/models/"
done
ls -la "$WWW/lib" "$WWW/models"
rm -rf "$TMP"
