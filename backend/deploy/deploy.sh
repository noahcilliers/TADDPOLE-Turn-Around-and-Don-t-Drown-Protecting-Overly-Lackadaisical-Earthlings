#!/usr/bin/env bash
# Push backend + frontend to the EC2 box and (re)start them.
#   HOST=ec2-user@<elastic-ip> KEY=~/.ssh/floodroute.pem ./deploy/deploy.sh
# First time only: scp your filled-in .env to /opt/floodroute/backend/.env on the host.
set -euo pipefail
: "${HOST:?set HOST=ec2-user@<ip>}"
KEY_OPT=${KEY:+-i $KEY}
cd "$(dirname "$0")/.."
[ -f data/camelback.graphml ] || { echo "data/camelback.graphml missing - run scripts/build_graph.py first"; exit 1; }
# Layout on the host: /opt/floodroute/backend (compose project, .env lives here) + /opt/floodroute/frontend
rsync -az --delete -e "ssh $KEY_OPT" \
  --exclude .venv --exclude .env --exclude __pycache__ --exclude .pytest_cache \
  ./ "$HOST:/opt/floodroute/backend/"
rsync -az --delete -e "ssh $KEY_OPT" \
  --exclude node_modules --exclude dist \
  ../frontend/ "$HOST:/opt/floodroute/frontend/"
ssh $KEY_OPT "$HOST" 'cd /opt/floodroute/backend && test -f .env && docker compose up -d --build && docker compose ps'
