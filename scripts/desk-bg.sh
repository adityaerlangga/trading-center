#!/usr/bin/env bash
# Run trading-center in the background via PM2 (survives closing browser / IDE).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p logs

NAME="trading-center"
PORT="${PORT:-3000}"
cmd="${1:-start}"

case "$cmd" in
  start)
    echo "building…"
    npm run build
    # Ensure previous instance is gone.
    npx --yes pm2 delete "$NAME" >/dev/null 2>&1 || true
    if command -v lsof >/dev/null 2>&1; then
      pids="$(lsof -ti ":$PORT" 2>/dev/null || true)"
      if [[ -n "${pids:-}" ]]; then
        kill $pids 2>/dev/null || true
        sleep 1
        kill -9 $pids 2>/dev/null || true
      fi
    fi
    echo "starting $NAME on :$PORT via pm2…"
    npx --yes pm2 start "npx next start -p $PORT" \
      --name "$NAME" \
      --cwd "$ROOT" \
      --time \
      --output "$ROOT/logs/desk.out.log" \
      --error "$ROOT/logs/desk.err.log"
    npx --yes pm2 save
    # Wait until HTTP is up, then nudge engines.
    for i in $(seq 1 30); do
      if curl -fsS "http://127.0.0.1:$PORT/api/snapshot?env=live" >/dev/null 2>&1; then
        break
      fi
      sleep 1
    done
    curl -fsS "http://127.0.0.1:$PORT/api/snapshot?env=live" >/dev/null || true
    curl -fsS "http://127.0.0.1:$PORT/api/snapshot?env=paper" >/dev/null || true
    echo "desk started"
    npx --yes pm2 status "$NAME"
    ;;
  stop)
    echo "stopping engines…"
    curl -fsS -X POST "http://127.0.0.1:$PORT/api/engine" \
      -H 'Content-Type: application/json' \
      -d '{"action":"stop","env":"live"}' >/dev/null 2>&1 || true
    curl -fsS -X POST "http://127.0.0.1:$PORT/api/engine" \
      -H 'Content-Type: application/json' \
      -d '{"action":"stop","env":"paper"}' >/dev/null 2>&1 || true
    npx --yes pm2 stop "$NAME" >/dev/null 2>&1 || true
    npx --yes pm2 delete "$NAME" >/dev/null 2>&1 || true
    echo "desk stopped"
    ;;
  status)
    npx --yes pm2 status "$NAME" || true
    curl -fsS "http://127.0.0.1:$PORT/api/snapshot?env=live" 2>/dev/null \
      | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{const s=JSON.parse(d);console.log("live:",s.running?"RUNNING":(s.starting?"STARTING":"idle"),s.agents?.[0]?.id||"-","usdt",s.agents?.[0]?.usdt??"-","hold",s.agents?.[0]?.positionCount??0);}catch{console.log("live: unreachable");}});' \
      || echo "live: unreachable"
    ;;
  logs)
    npx --yes pm2 logs "$NAME" --lines "${2:-80}" --nostream
    ;;
  *)
    echo "usage: $0 {start|stop|status|logs}"
    exit 1
    ;;
esac
