#!/usr/bin/env bash
# Push the backend to the EC2 box and (re)start it.
#   HOST=ec2-user@<elastic-ip> KEY=~/.ssh/floodroute.pem ./deploy/deploy.sh
# First time only: scp your filled-in .env to /opt/floodroute/.env on the host.
set -euo pipefail
: "${HOST:?set HOST=ec2-user@<ip>}"
KEY_OPT=${KEY:+-i $KEY}
cd "$(dirname "$0")/.."
[ -f data/camelback.graphml ] || { echo "data/camelback.graphml missing - run scripts/build_graph.py first"; exit 1; }
rsync -az --delete -e "ssh $KEY_OPT" \
  --exclude .venv --exclude .env --exclude __pycache__ --exclude .pytest_cache \
  ./ "$HOST:/opt/floodroute/"
ssh $KEY_OPT "$HOST" 'cd /opt/floodroute && test -f .env && docker compose up -d --build && docker compose ps'
