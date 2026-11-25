#!/usr/bin/env bash
# Container smoke test: runs the production Compose file against a local image, checks the
# hardening actually applied, then the full delivery contract at the root and behind an nginx
# path-prefix proxy, and finally a graceful stop. Evidence -> evidence/deployment/<arch>/.
set -euo pipefail
cd "$(dirname "$0")/.."
image="${SCORCHED_IMAGE:-scorched-earth:local}"
project="scorched-smoke-$$"
export SCORCHED_IMAGE="$image" SCORCHED_PORT="${SCORCHED_PORT:-18096}" SCORCHED_NETWORK="$project"
export SCORCHED_PLATFORM="${SCORCHED_PLATFORM:-$(docker image inspect "$image" --format '{{.Os}}/{{.Architecture}}')}"
export SCORCHED_EVIDENCE_DIR="${SCORCHED_EVIDENCE_DIR:-evidence/deployment/${SCORCHED_PLATFORM#linux/}}"
proxy_image="${SCORCHED_PROXY_IMAGE:-nginx:1.30.6-alpine@sha256:47928bf67eb62a1863cb08d9ecb52d3e704304ba614eaee17884204677702951}"
proxy_port="${SCORCHED_PROXY_PORT:-18097}"
compose=(docker compose -p "$project" -f deploy/compose.production.yml)
mkdir -p "$SCORCHED_EVIDENCE_DIR"
cleanup() {
  result=$?
  trap - EXIT
  "${compose[@]}" logs --no-color > "$SCORCHED_EVIDENCE_DIR/container.log" 2>&1 || true
  docker logs "$project-proxy" > "$SCORCHED_EVIDENCE_DIR/proxy.log" 2>&1 || true
  if [ "$result" -ne 0 ]; then cat "$SCORCHED_EVIDENCE_DIR/container.log" >&2; fi
  docker rm -f "$project-proxy" >/dev/null 2>&1 || true
  "${compose[@]}" down --remove-orphans --volumes >/dev/null 2>&1 || true
  docker network rm "$project" >/dev/null 2>&1 || true
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
test -f dist/index.html || { echo 'Run npm run build before testing the container.' >&2; exit 1; }
docker image inspect "$image" > "$SCORCHED_EVIDENCE_DIR/image.json"
docker network create "$project" >/dev/null
"${compose[@]}" config --quiet
"${compose[@]}" up -d --no-build --pull never --wait --wait-timeout 90
id=$("${compose[@]}" ps -q scorched-earth)
docker inspect "$id" > "$SCORCHED_EVIDENCE_DIR/container-inspect.json"
docker exec "$id" sh -ec 'test "$(id -u)" = 1000; test ! -w /srv/scorched; test -w /tmp; grep -Eq "^CapEff:[[:space:]]+0+$" /proc/1/status; grep -Eq "^NoNewPrivs:[[:space:]]+1$" /proc/1/status; if touch /srv/scorched/write-test 2>/dev/null; then exit 1; fi; if touch /write-test 2>/dev/null; then exit 1; fi'
python3 - <<'PY'
import json,os
directory=os.environ['SCORCHED_EVIDENCE_DIR']
data=json.load(open(f'{directory}/container-inspect.json'))[0]
image=json.load(open(f'{directory}/image.json'))[0]
assert f"{image['Os']}/{image['Architecture']}"==os.environ['SCORCHED_PLATFORM']
assert data['Config']['User']=='1000:1000'
host=data['HostConfig']
assert host['ReadonlyRootfs'] is True
assert host['CapDrop']==['ALL']
assert any('no-new-privileges' in item for item in host['SecurityOpt'])
assert all(flag in host['Tmpfs']['/tmp'] for flag in ['noexec','nosuid','nodev','size=16m'])
assert host['PortBindings']['8080/tcp'][0]['HostIp']=='127.0.0.1'
assert host['PidsLimit']==64
assert host['Memory']==256*1024*1024
assert host['NanoCpus']==1_000_000_000
assert host['LogConfig']=={'Type':'json-file','Config':{'max-size':'10m','max-file':'3'}}
assert data['State']['Health']['Status']=='healthy'
assert any(e.startswith('NODE_OPTIONS=--max-old-space-size=') for e in data['Config']['Env'])
PY
node scripts/check-delivery.mjs "http://127.0.0.1:$SCORCHED_PORT/" | tee "$SCORCHED_EVIDENCE_DIR/delivery-root.json"
if [ "${SCORCHED_SKIP_PREFIX:-0}" != "1" ]; then
  docker run -d --name "$project-proxy" --network "$project" -p "127.0.0.1:$proxy_port:8080" \
    --mount "type=bind,src=$PWD/deploy/nginx/test-prefix.conf,dst=/etc/nginx/conf.d/default.conf,readonly" "$proxy_image" >/dev/null
  for attempt in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:$proxy_port/qa/scorched/" -o /dev/null; then break; fi
    sleep 1
  done
  test "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$proxy_port/qa/scorched")" = 308
  node scripts/check-delivery.mjs "http://127.0.0.1:$proxy_port/qa/scorched/" | tee "$SCORCHED_EVIDENCE_DIR/delivery-prefix.json"
fi
# Graceful stop: SIGTERM must drain and exit 0 well inside stop_grace_period.
docker exec "$id" node -e '
  const { openLeaderboard } = require("./server/lib/leaderboard");
  openLeaderboard(process.env.LEADERBOARD_FILE).record({
    round: 1, tanks: [{ type: "human", name: "Volume pilot", score: 250, kills: 1 }]
  });
'
start=$(date +%s)
"${compose[@]}" stop -t 30 >/dev/null
elapsed=$(( $(date +%s) - start ))
code=$(docker inspect "$id" --format '{{.State.ExitCode}}')
test "$code" = 0 || { echo "container exited with $code" >&2; exit 1; }
test "$elapsed" -lt 15 || { echo "graceful stop took ${elapsed}s" >&2; exit 1; }
"${compose[@]}" up -d --no-build --pull never --force-recreate --wait --wait-timeout 90
test "$("${compose[@]}" ps -q scorched-earth)" != "$id"
SCORCHED_EXPECT_VOLUME_PILOT=1 node scripts/check-delivery.mjs "http://127.0.0.1:$SCORCHED_PORT/" | tee "$SCORCHED_EVIDENCE_DIR/delivery-recreated.json"
scope="root and /qa/scorched/ prefix"; [ "${SCORCHED_SKIP_PREFIX:-0}" = "1" ] && scope="root (prefix proxy skipped)"
echo "Container hardening, $scope delivery, graceful stop (${elapsed}s), and leaderboard persistence passed."
