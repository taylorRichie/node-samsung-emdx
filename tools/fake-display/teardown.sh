#!/usr/bin/env bash
# Removes everything run.sh started: containers labelled emdx-test=1 (the app
# instance and the fakes) and the emdx-test network. Saved images in out/ are kept.
# Never touches samsung-emdx or node-samsung-emdx_default.
set -uo pipefail

ids="$(docker ps -aq --filter label=emdx-test=1)"
if [[ -n "$ids" ]]; then
  docker ps -a --filter label=emdx-test=1 --format 'Removing {{.Names}}'
  docker rm -f $ids >/dev/null
else
  echo "No emdx-test containers"
fi

if docker network inspect emdx-test >/dev/null 2>&1; then
  docker network rm emdx-test >/dev/null && echo "Removed network emdx-test"
else
  echo "No emdx-test network"
fi
