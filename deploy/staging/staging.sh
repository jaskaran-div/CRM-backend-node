#!/bin/bash
# Derivion CRM STAGING stack on the EC2 host, fully isolated from production:
#   staging PostgreSQL 127.0.0.1:55433 (synthetic data) <- Node API 127.0.0.1:8082 <- Next.js 127.0.0.1:3002
# Nothing is public: no Nginx/systemd/firewall change. Reach it through an SSH tunnel:
#   ssh -i <key> -L 3002:127.0.0.1:3002 -L 8082:127.0.0.1:8082 ec2-user@<host>   then open http://localhost:3002
# It never reads ~/.config/derivion/crm.env (production credentials).
#
# Usage: staging.sh init | start | stop | status | smoke | destroy
set -euo pipefail
ROOT="${STAGING_DIR:-$HOME/staging}"
ENVF="$HOME/.config/derivion/staging.env"
API="$ROOT/backend"; WEB="$ROOT/frontend"; LOG="$ROOT/logs"; RUN="$ROOT/run"
mkdir -p "$LOG" "$RUN"

[ -f "$ENVF" ] || { echo "missing $ENVF (see staging.env.example)"; exit 1; }
[ "$(stat -c %a "$ENVF")" = "600" ] || { echo "$ENVF must be mode 600"; exit 1; }
set -a; . "$ENVF"; set +a
export STAGING_DIR="$ROOT"
case "${DB_URL:-}" in *127.0.0.1:55433/crm_staging*) ;; *) echo "refusing: DB_URL must point at the staging database"; exit 1;; esac

start_bg() { # name, workdir, command...
  local name=$1 dir=$2; shift 2
  if [ -f "$RUN/$name.pid" ] && kill -0 "$(cat "$RUN/$name.pid")" 2>/dev/null; then echo "$name already running"; return; fi
  ( cd "$dir" && setsid nohup "$@" >> "$LOG/$name.log" 2>&1 < /dev/null & echo $! > "$RUN/$name.pid" )
}
wait_for() { # url, expected-code-regex, label
  for _ in $(seq 1 90); do
    c=$(curl -s -o /dev/null -w '%{http_code}' "$1" || true); [[ "$c" =~ $2 ]] && { echo "$3 ready ($c)"; return 0; }; sleep 1
  done; echo "$3 did not become ready"; return 1
}

case "${1:-}" in
  init)
    (cd "$API/deploy/staging" && node staging-db.mjs init) ;;
  start)
    start_bg postgres "$API/deploy/staging" node staging-db.mjs run
    sleep 3
    start_bg api "$API" node --max-old-space-size=192 dist/server.js
    wait_for "http://127.0.0.1:8082/api/health" '^200$' "api"
    start_bg web "$WEB" npx next start --hostname 127.0.0.1 --port 3002
    wait_for "http://127.0.0.1:3002/" '^(200|307|308)$' "web" ;;
  stop)
    for n in web api postgres; do
      if [ -f "$RUN/$n.pid" ]; then kill -- -"$(cat "$RUN/$n.pid")" 2>/dev/null || kill "$(cat "$RUN/$n.pid")" 2>/dev/null || true; rm -f "$RUN/$n.pid"; echo "stopped $n"; fi
    done ;;
  status)
    for n in postgres api web; do
      if [ -f "$RUN/$n.pid" ] && kill -0 "$(cat "$RUN/$n.pid")" 2>/dev/null; then echo "$n running (pid $(cat "$RUN/$n.pid"))"; else echo "$n stopped"; fi
    done
    ss -ltn | grep -E '127\.0\.0\.1:(55433|8082|3002)\s' || true ;;
  smoke)
    node "$API/deploy/staging/smoke.mjs" http://127.0.0.1:8082 ;;
  destroy)
    "$0" stop || true
    (cd "$API/deploy/staging" && node staging-db.mjs reset) ;;
  *) echo "usage: $0 init|start|stop|status|smoke|destroy"; exit 1 ;;
esac
