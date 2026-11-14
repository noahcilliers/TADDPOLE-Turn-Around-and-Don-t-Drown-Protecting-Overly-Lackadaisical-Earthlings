#!/usr/bin/env bash
# Run once on a fresh Amazon Linux 2023 EC2 instance (or paste as user data).
# Security group: allow inbound 22 (your IP), 80 and 443 (anywhere).
set -euo pipefail
sudo dnf install -y docker rsync
sudo systemctl enable --now docker
sudo usermod -aG docker ec2-user
sudo mkdir -p /usr/local/lib/docker/cli-plugins
ARCH=$(uname -m)
sudo curl -fsSL "https://github.com/docker/compose/releases/download/v2.39.2/docker-compose-linux-${ARCH}" \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
sudo mkdir -p /opt/floodroute && sudo chown ec2-user /opt/floodroute
echo "done - log out and back in so the docker group applies"
