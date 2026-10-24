#!/usr/bin/env bash
# Run as root after DNS points max-click.iteacher-ai.org at this VPS.
set -Eeuo pipefail

if [ "$EUID" -ne 0 ]; then
    echo "Run this script as root or with sudo." >&2
    exit 1
fi

APP_ROOT=/var/www/clicker
DEPLOY_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DOMAIN=max-click.iteacher-ai.org
CERT_DIR="/etc/letsencrypt/live/$DOMAIN"
SITE=/etc/nginx/sites-available/clicker-ai

test -f "$APP_ROOT/.env" || { echo "Missing $APP_ROOT/.env" >&2; exit 1; }
set -a
. "$APP_ROOT/.env"
set +a
if [ -z "${CLICKER_CERTBOT_EMAIL:-}" ] || [ "$CLICKER_CERTBOT_EMAIL" = "replace-with-your-email@example.com" ]; then
    echo "Set a real CLICKER_CERTBOT_EMAIL in $APP_ROOT/.env first." >&2
    exit 1
fi

command -v certbot >/dev/null
nginx -t
install -d -m 0755 /var/www/certbot

# Only this domain's virtual host is changed; the original site stays online.
if [ ! -f "$CERT_DIR/fullchain.pem" ] || [ ! -f "$CERT_DIR/privkey.pem" ]; then
    install -m 0644 "$DEPLOY_DIR/nginx-clicker-ai-http.conf" "$SITE"
    ln -sfn "$SITE" /etc/nginx/sites-enabled/clicker-ai
    nginx -t
    systemctl reload nginx
fi

# Certbot persists the deploy hook so Nginx also loads renewed certificates.
certbot certonly --webroot -w /var/www/certbot \
    --cert-name "$DOMAIN" -d "$DOMAIN" \
    --non-interactive --agree-tos --keep-until-expiring \
    --email "$CLICKER_CERTBOT_EMAIL" \
    --deploy-hook '/usr/sbin/nginx -t && /usr/bin/systemctl reload nginx'

test -s "$CERT_DIR/fullchain.pem"
test -s "$CERT_DIR/privkey.pem"
install -m 0644 "$DEPLOY_DIR/nginx-clicker-ai.conf" "$SITE"
ln -sfn "$SITE" /etc/nginx/sites-enabled/clicker-ai
nginx -t
systemctl reload nginx
echo "HTTPS configured: https://$DOMAIN"
