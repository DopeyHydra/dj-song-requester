#!/usr/bin/env bash
# Baut die signierte Release-APK in Docker. Ergebnis: android/DJSongRequester.apk
# Beim ersten Lauf wird ein Signatur-Schlüssel (release.jks) erzeugt – UNBEDINGT SICHERN,
# sonst lassen sich spätere Versionen nicht als Update über die installierte App installieren.
set -euo pipefail
cd "$(dirname "$0")"
export MSYS_NO_PATHCONV=1                    # Git Bash unter Windows: Pfade nicht umschreiben
HOST_DIR="$( (pwd -W 2>/dev/null) || pwd )"  # Windows-Pfad für docker -v
IMAGE=djsr-android-build

docker build -t "$IMAGE" -f build.Dockerfile .

run() { docker run --rm -v "$HOST_DIR:/project" -v djsr-gradle-cache:/root/.gradle "$IMAGE" bash -c "$1"; }

if [ ! -f keystore.properties ]; then
  echo ">> Erzeuge Signatur-Schlüssel (release.jks) …"
  PASS=$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)
  run "keytool -genkeypair -v -keystore release.jks -storetype PKCS12 -alias djsr -keyalg RSA -keysize 4096 \
       -validity 10000 -storepass '$PASS' -keypass '$PASS' -dname 'CN=DJ Song Requester, O=DopeyHydra' > /dev/null 2>&1"
  printf 'storeFile=release.jks\nstorePassword=%s\nkeyAlias=djsr\nkeyPassword=%s\n' "$PASS" "$PASS" > keystore.properties
fi

run "gradle --no-daemon -q assembleRelease && cp app/build/outputs/apk/release/app-release.apk DJSongRequester.apk"
echo ">> Fertig: $(pwd)/DJSongRequester.apk"
