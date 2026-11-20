#!/usr/bin/env bash
# Starts a throwaway app instance plus N fake EMDX displays on their own Docker
# network, points the app at itself, and registers one display per fake.
# See README.md in this folder.
#
#   ./run.sh [app-image] [fake-count]      defaults: samsung-emdx:latest 3
#
# Writes into this folder (all git-ignored): certs/ (self-signed TLS cert, made
# once), out/fake-display-N/ (what each fake received), display-ids.txt.
#
# Env: PIN (default 123456), APP_PORT (host port, default 3011),
#      FAKE_ORIENTATION (portrait|landscape, default portrait),
#      FAKE_IMAGE (default node:24-bookworm-slim), TZ (passed to all containers if set)
#
# Never touches the samsung-emdx container, its network or its volumes.
set -euo pipefail

IMAGE="${1:-samsung-emdx:latest}"
COUNT="${2:-3}"
PIN="${PIN:-123456}"
APP_PORT="${APP_PORT:-3011}"
FAKE_IMAGE="${FAKE_IMAGE:-node:24-bookworm-slim}"
FAKE_ORIENTATION="${FAKE_ORIENTATION:-portrait}"
NETWORK=emdx-test
APP=emdx-test-app
LABEL=emdx-test=1
DIR="$(cd "$(dirname "$0")" && pwd)"
API="http://localhost:${APP_PORT}/api"

[[ "$COUNT" =~ ^[0-9]+$ ]] && (( COUNT >= 1 )) || { echo "fake count must be a positive number" >&2; exit 1; }
TZ_ARGS=()
[[ -n "${TZ:-}" ]] && TZ_ARGS=(-e "TZ=$TZ")

# Leftovers from an earlier run
"$DIR/teardown.sh" >/dev/null 2>&1 || true

if lsof -nP -iTCP:"$APP_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $APP_PORT is already in use on this machine; set APP_PORT to another port." >&2
  exit 1
fi

# Self-signed cert for the fakes' TLS (made once, reused)
mkdir -p "$DIR/certs"
if [[ ! -s "$DIR/certs/key.pem" || ! -s "$DIR/certs/cert.pem" ]]; then
  echo "Creating self-signed certificate in $DIR/certs"
  openssl req -x509 -newkey rsa:2048 -noenc -keyout "$DIR/certs/key.pem" -out "$DIR/certs/cert.pem" \
      -days 3650 -subj '/CN=Samsung EMDX (fake)' >/dev/null 2>&1 \
    || openssl req -x509 -newkey rsa:2048 -nodes -keyout "$DIR/certs/key.pem" -out "$DIR/certs/cert.pem" \
      -days 3650 -subj '/CN=Samsung EMDX (fake)' >/dev/null 2>&1
fi
chmod 644 "$DIR/certs/key.pem" "$DIR/certs/cert.pem"   # readable by any container user

docker network create --label "$LABEL" "$NETWORK" >/dev/null
echo "Network $NETWORK created"

# Throwaway app: no volumes, so its state goes with the container
docker run -d --name "$APP" --hostname "$APP" --network "$NETWORK" --label "$LABEL" \
  -p "${APP_PORT}:3001" "${TZ_ARGS[@]+"${TZ_ARGS[@]}"}" "$IMAGE" >/dev/null
echo "App $APP started from $IMAGE (http://localhost:${APP_PORT})"

for i in $(seq 1 "$COUNT"); do
  name="fake-display-$i"
  mkdir -p "$DIR/out/$name"
  docker run -d --name "$name" --hostname "$name" --network "$NETWORK" --label "$LABEL" \
    -e PIN="$PIN" -e NAME="$name" -e OUT=/out -e ORIENTATION="$FAKE_ORIENTATION" "${TZ_ARGS[@]+"${TZ_ARGS[@]}"}" \
    -v "$DIR/fake-display.mjs:/fake/fake-display.mjs:ro" \
    -v "$DIR/certs:/fake/certs:ro" \
    -v "$DIR/out/$name:/out" \
    "$FAKE_IMAGE" node /fake/fake-display.mjs >/dev/null
  echo "Fake $name started (saves to $DIR/out/$name)"
done

echo -n "Waiting for the app"
for _ in $(seq 1 60); do
  curl -fsS "$API/displays" >/dev/null 2>&1 && break
  echo -n .; sleep 1
done
echo
curl -fsS "$API/displays" >/dev/null || { echo "App didn't come up; docker logs $APP:" >&2; docker logs --tail 50 "$APP" >&2; exit 1; }

for i in $(seq 1 "$COUNT"); do
  for _ in $(seq 1 20); do
    docker logs "fake-display-$i" 2>&1 | grep -q 'listening' && break
    sleep 0.5
  done
  docker logs "fake-display-$i" 2>&1 | grep -q 'listening' || { echo "fake-display-$i didn't start:" >&2; docker logs "fake-display-$i" >&2; exit 1; }
done

echo "Server address: $(curl -fsS -X PUT "$API/app-settings" -H 'Content-Type: application/json' \
  -d "{\"serverAddress\":\"$APP\"}")"

: > "$DIR/display-ids.txt"
echo
echo "Displays:"
for i in $(seq 1 "$COUNT"); do
  name="fake-display-$i"
  body="$(curl -fsS -X POST "$API/displays" -H 'Content-Type: application/json' \
    -d "{\"name\":\"$name\",\"host\":\"$name\",\"pin\":\"$PIN\"}")"
  id="$(printf '%s' "$body" | sed -E 's/.*"id":"([^"]+)".*/\1/')"
  printf '%s\t%s\n' "$name" "$id" | tee -a "$DIR/display-ids.txt"
done
echo
echo "IDs saved to $DIR/display-ids.txt. App UI: http://localhost:${APP_PORT}"
echo "Fake logs: docker logs -f fake-display-1    Images: $DIR/out/fake-display-N/"
