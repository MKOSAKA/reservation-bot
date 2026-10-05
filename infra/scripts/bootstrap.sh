#!/bin/bash
# インスタンス初回構築（root で実行。UserData から呼ばれる。再実行しても壊れないように書く）
set -euo pipefail
APP=/opt/reservation-bot
DATA=/var/lib/reservation-bot
ETC=/etc/reservation-bot
export DEBIAN_FRONTEND=noninteractive

# --- 時刻同期: chrony + Amazon Time Sync Service（解禁時刻の精度の前提）
apt-get install -y chrony
cat > /etc/chrony/sources.d/aws-time-sync.sources <<'CONF'
server 169.254.169.123 prefer iburst minpoll 4 maxpoll 4
CONF
systemctl enable --now chrony
chronyc reload sources || true

# --- Node.js 22
if ! command -v node >/dev/null || ! node -v | grep -q '^v22'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

# --- 実行ユーザーとディレクトリ
id rbot >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin rbot
install -d -o rbot -g rbot -m 0700 "$DATA"
install -d -o root -g rbot -m 0750 "$ETC"
chown -R rbot:rbot "$APP"

# --- アプリのビルドと Chromium
export PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
sudo -u rbot -H bash -c "cd $APP && npm ci && npm run build"
npx --prefix "$APP" playwright install-deps chromium
install -d -o rbot -g rbot -m 0755 /opt/pw-browsers
sudo -u rbot -H env PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers bash -c "cd $APP && npx playwright install chromium"

# --- 非秘密の設定（インスタンスIDなどは IMDSv2 から取得）
IMDS_TOKEN=$(curl -sX PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')
DOC=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/dynamic/instance-identity/document)
INSTANCE_ID=$(echo "$DOC" | jq -r .instanceId)
REGION=$(echo "$DOC" | jq -r .region)
ACCOUNT=$(echo "$DOC" | jq -r .accountId)
cat > "$ETC/config.env" <<CONF
TZ=Asia/Tokyo
NODE_ENV=production
DATA_DIR=$DATA
HOME=$DATA
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
AWS_REGION=$REGION
WAKE_INSTANCE_ID=$INSTANCE_ID
WAKE_ROLE_ARN=arn:aws:iam::$ACCOUNT:role/reservation-bot-wake
WAKE_SCHEDULE_GROUP=reservation-bot
AUTO_POWEROFF=1
# 確定ボタンを押すか（1=押す）。LaBOLA はクラウドから予約導線が 403 のため 0
LABOLA_ALLOW_SUBMIT=0
# スタジオルは 2026-10-05 実予約試験に合格し、ユーザーが自動確定を了承
STUDIOL_ALLOW_SUBMIT=1
CONF
chmod 0640 "$ETC/config.env"; chown root:rbot "$ETC/config.env"

# --- 秘密情報の展開と systemd
bash "$APP/infra/scripts/fetch-secrets.sh"
install -m 0644 "$APP/deploy/reservation-bot.service" /etc/systemd/system/reservation-bot.service
systemctl daemon-reload
systemctl enable --now reservation-bot
echo "bootstrap done"
