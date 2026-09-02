#!/usr/bin/env bash
# Deploy or update code. Run as root after the first clone is present.
set -Eeuo pipefail

APP_ROOT=/var/www/clicker
APP_USER=clicker

test -d "$APP_ROOT/app/.git" || { echo "Repository has not been cloned yet." >&2; exit 1; }
test -f "$APP_ROOT/.env" || { echo "Missing $APP_ROOT/.env" >&2; exit 1; }
set -a
. "$APP_ROOT/.env"
set +a

sudo -u "$APP_USER" git -C "$APP_ROOT/app" pull --ff-only
sudo -u "$APP_USER" "$APP_ROOT/venv/bin/python" -m pip install --upgrade -r "$APP_ROOT/app/requirements.txt" || {
    sudo -u "$APP_USER" python3 -m venv "$APP_ROOT/venv"
    sudo -u "$APP_USER" "$APP_ROOT/venv/bin/python" -m pip install --upgrade pip
    sudo -u "$APP_USER" "$APP_ROOT/venv/bin/python" -m pip install -r "$APP_ROOT/app/requirements.txt"
}

install -m 0644 "$APP_ROOT/app/deploy/clicker.service" /etc/systemd/system/clicker.service
install -d -m 0755 /var/www/certbot
if [ ! -f /etc/letsencrypt/live/max_click_pesh.iteacher-alex.org/fullchain.pem ]; then
    install -m 0644 "$APP_ROOT/app/deploy/nginx-clicker-http.conf" /etc/nginx/sites-available/clicker
    ln -sfn /etc/nginx/sites-available/clicker /etc/nginx/sites-enabled/clicker
    rm -f /etc/nginx/sites-enabled/default
    nginx -t
    systemctl reload nginx
    test -n "${CLICKER_CERTBOT_EMAIL:-}" || { echo "Set CLICKER_CERTBOT_EMAIL in $APP_ROOT/.env" >&2; exit 1; }
    certbot certonly --webroot -w /var/www/certbot -d max_click_pesh.iteacher-alex.org --non-interactive --agree-tos --email "$CLICKER_CERTBOT_EMAIL"
fi
install -m 0644 "$APP_ROOT/app/deploy/nginx-clicker.conf" /etc/nginx/sites-available/clicker
ln -sfn /etc/nginx/sites-available/clicker /etc/nginx/sites-enabled/clicker
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl daemon-reload
systemctl enable --now clicker
systemctl reload nginx
