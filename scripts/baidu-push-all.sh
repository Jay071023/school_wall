#!/usr/bin/env bash
set -euo pipefail

: "${DB_USER:?请设置 DB_USER}"
: "${DB_PASSWORD:?请设置 DB_PASSWORD}"
: "${DB_NAME:?请设置 DB_NAME}"
: "${BAIDU_PUSH_TOKEN:?请设置 BAIDU_PUSH_TOKEN}"

BAIDU_SITE_URL="${BAIDU_SITE_URL:-https://campus-wall.example}"
BAIDU_PUSH_API="${BAIDU_PUSH_API:-http://data.zz.baidu.com/urls}"
DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-3306}"
URL_FILE="${TMPDIR:-/tmp}/baidu_urls.txt"

MYSQL_PWD="$DB_PASSWORD" mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" "$DB_NAME" -N -B \
  -e "SELECT CONCAT('${BAIDU_SITE_URL}/post-detail.html?id=', id) FROM posts WHERE status = 'approved' AND is_deleted = 0 ORDER BY id;" \
  2>/dev/null | tr '\t' '\n' > "$URL_FILE"

curl --fail --silent --show-error -X POST \
  "${BAIDU_PUSH_API}?site=${BAIDU_SITE_URL}&token=${BAIDU_PUSH_TOKEN}" \
  -H 'Content-Type: text/plain' --data-binary "@$URL_FILE"
printf '\nSubmitted %s URLs\n' "$(wc -l < "$URL_FILE")"
