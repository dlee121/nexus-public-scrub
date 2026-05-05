#!/usr/bin/env bash
# ============================================================
# WordPress VPS Deployment Script
# Runs on Ubuntu 22.04 / Debian 12
#
# Usage:
#   SSH into your VPS, then run:
#   curl -sSL <this-script-url> | bash -s -- <domain> <db_name> <db_user> <db_pass>
#
# Or copy this script to the VPS and run:
#   chmod +x wp-deploy.sh
#   sudo ./wp-deploy.sh yourdomain.com mydb mydbuser mydbpass
#
# After running:
#   1. Visit https://yourdomain.com/wp-admin/install.php to finish WP setup
#   2. Create an Application Password in WP Admin → Users → Profile
#   3. Update config/content-sites.json with the WP URL, user, and app password
# ============================================================

set -euo pipefail

DOMAIN="${1:?Usage: $0 <domain> <db_name> <db_user> <db_pass>}"
DB_NAME="${2:?Missing db_name}"
DB_USER="${3:?Missing db_user}"
DB_PASS="${4:?Missing db_pass}"
WP_PATH="/var/www/${DOMAIN}"

echo "=== Deploying WordPress for ${DOMAIN} ==="

# ── System Update ────────────────────────────────────────────
echo "[1/8] Updating system..."
apt-get update -qq
apt-get upgrade -y -qq

# ── Install Nginx + PHP + MariaDB ────────────────────────────
echo "[2/8] Installing Nginx, PHP, MariaDB..."
apt-get install -y -qq \
  nginx \
  mariadb-server \
  php8.2-fpm \
  php8.2-mysql \
  php8.2-xml \
  php8.2-mbstring \
  php8.2-curl \
  php8.2-gd \
  php8.2-zip \
  php8.2-imagick \
  unzip \
  curl \
  certbot \
  python3-certbot-nginx

# ── Configure MariaDB ─────────────────────────────────────────
echo "[3/8] Configuring database..."
mysql -e "CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
mysql -e "CREATE USER IF NOT EXISTS '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASS}';"
mysql -e "GRANT ALL PRIVILEGES ON \`${DB_NAME}\`.* TO '${DB_USER}'@'localhost';"
mysql -e "FLUSH PRIVILEGES;"

# ── Install WP-CLI ────────────────────────────────────────────
echo "[4/8] Installing WP-CLI..."
if ! command -v wp &>/dev/null; then
  curl -sO https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar
  chmod +x wp-cli.phar
  mv wp-cli.phar /usr/local/bin/wp
fi

# ── Download WordPress ────────────────────────────────────────
echo "[5/8] Downloading WordPress..."
mkdir -p "${WP_PATH}"
wp core download --path="${WP_PATH}" --allow-root

# Configure wp-config.php
wp config create \
  --path="${WP_PATH}" \
  --dbname="${DB_NAME}" \
  --dbuser="${DB_USER}" \
  --dbpass="${DB_PASS}" \
  --dbhost="localhost" \
  --allow-root

# Set file permissions
chown -R www-data:www-data "${WP_PATH}"
find "${WP_PATH}" -type d -exec chmod 755 {} \;
find "${WP_PATH}" -type f -exec chmod 644 {} \;

# ── Configure Nginx ────────────────────────────────────────────
echo "[6/8] Configuring Nginx..."
cat > "/etc/nginx/sites-available/${DOMAIN}" <<EOF
server {
    listen 80;
    server_name ${DOMAIN} www.${DOMAIN};
    root ${WP_PATH};
    index index.php;

    client_max_body_size 64M;

    location / {
        try_files \$uri \$uri/ /index.php?\$args;
    }

    location ~ \.php$ {
        include snippets/fastcgi-php.conf;
        fastcgi_pass unix:/run/php/php8.2-fpm.sock;
        fastcgi_param SCRIPT_FILENAME \$document_root\$fastcgi_script_name;
    }

    location ~* \.(css|js|png|jpg|jpeg|gif|ico|svg|woff|woff2)$ {
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    location = /favicon.ico { log_not_found off; access_log off; }
    location = /robots.txt  { allow all; log_not_found off; access_log off; }
    location ~ /\.          { deny all; }
}
EOF

ln -sf "/etc/nginx/sites-available/${DOMAIN}" "/etc/nginx/sites-enabled/${DOMAIN}"
nginx -t
systemctl reload nginx

# ── SSL via Let's Encrypt ─────────────────────────────────────
echo "[7/8] Setting up SSL..."
certbot --nginx -d "${DOMAIN}" -d "www.${DOMAIN}" --non-interactive --agree-tos -m "admin@${DOMAIN}" || \
  echo "WARNING: SSL setup failed — configure manually or domain may not be pointed yet"

# ── Install Recommended Plugins ──────────────────────────────
echo "[8/8] Installing plugins..."
# Complete WP install first (headless)
WP_ADMIN_USER="admin"
WP_ADMIN_PASS=$(openssl rand -base64 16)
WP_ADMIN_EMAIL="admin@${DOMAIN}"

wp core install \
  --path="${WP_PATH}" \
  --url="https://${DOMAIN}" \
  --title="${DOMAIN}" \
  --admin_user="${WP_ADMIN_USER}" \
  --admin_password="${WP_ADMIN_PASS}" \
  --admin_email="${WP_ADMIN_EMAIL}" \
  --allow-root

# SEO: Yoast
wp plugin install wordpress-seo --activate --path="${WP_PATH}" --allow-root
# Caching
wp plugin install w3-total-cache --activate --path="${WP_PATH}" --allow-root
# Security
wp plugin install wordfence --path="${WP_PATH}" --allow-root

# Set permalink structure (required for REST API)
wp rewrite structure '/%postname%/' --path="${WP_PATH}" --allow-root
wp rewrite flush --path="${WP_PATH}" --allow-root

# Enable application passwords (WP 5.6+, enabled by default, but ensure REST API is on)
wp option update permalink_structure '/%postname%/' --path="${WP_PATH}" --allow-root

echo ""
echo "=== DEPLOYMENT COMPLETE ==="
echo ""
echo "Site:        https://${DOMAIN}"
echo "WP Admin:    https://${DOMAIN}/wp-admin"
echo "Admin user:  ${WP_ADMIN_USER}"
echo "Admin pass:  ${WP_ADMIN_PASS}"
echo ""
echo "NEXT STEPS:"
echo "  1. Log into WP admin and create an Application Password:"
echo "     Users → Profile → Application Passwords"
echo "  2. Update config/content-sites.json with:"
echo "     - url: https://${DOMAIN}"
echo "     - username: ${WP_ADMIN_USER}"
echo "     - appPassword: <the app password you just created>"
echo "  3. Install an SEO-optimized theme (recommend: GeneratePress or Astra)"
echo "     wp theme install generatepress --activate --path=${WP_PATH} --allow-root"
echo ""
echo "SAVE THESE CREDENTIALS — they won't be shown again."
