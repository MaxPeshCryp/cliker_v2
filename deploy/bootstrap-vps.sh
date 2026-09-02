#!/usr/bin/env bash
# Run once as root on the VPS: sudo bash bootstrap-vps.sh
set -Eeuo pipefail

APP_ROOT=/var/www/clicker
APP_USER=clicker
REPOSITORY=git@github.com:MaxPeshCryp/cliker_v2.git

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y python3 python3-venv python3-pip git nginx certbot python3-certbot-nginx openssh-client

id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
install -d -o "$APP_USER" -g "$APP_USER" -m 0750 "$APP_ROOT" "$APP_ROOT/data" "$APP_ROOT/.ssh"

# This key is deliberately stored in this project's isolated directory.
if [ ! -f "$APP_ROOT/.ssh/id_ed25519_github" ]; then
    sudo -u "$APP_USER" ssh-keygen -q -t ed25519 -N '' -f "$APP_ROOT/.ssh/id_ed25519_github" -C 'clicker-vps-deploy-key'
fi
chmod 700 "$APP_ROOT/.ssh"
chmod 600 "$APP_ROOT/.ssh/id_ed25519_github"
chown -R "$APP_USER:$APP_USER" "$APP_ROOT"

cat > "$APP_ROOT/.ssh/config" <<'EOF'
Host github.com
    HostName github.com
    User git
    IdentityFile /var/www/clicker/.ssh/id_ed25519_github
    IdentitiesOnly yes
    StrictHostKeyChecking accept-new
EOF
chmod 600 "$APP_ROOT/.ssh/config"
chown "$APP_USER:$APP_USER" "$APP_ROOT/.ssh/config"

echo
echo 'Add this public key in GitHub: repository Settings -> Deploy keys -> Add deploy key (read-only):'
cat "$APP_ROOT/.ssh/id_ed25519_github.pub"
echo
echo 'After adding it, run: sudo -u clicker git clone git@github.com:MaxPeshCryp/cliker_v2.git /var/www/clicker/app'
