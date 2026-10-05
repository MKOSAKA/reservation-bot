#!/bin/bash
# main を取り込んで再起動する（SSM で root 実行）。デプロイは手動運用。
set -euo pipefail
APP=/opt/reservation-bot
AWS=$(command -v aws || echo /snap/bin/aws)
TOKEN=$("$AWS" secretsmanager get-secret-value --secret-id reservation-bot/deploy-github-token --query SecretString --output text)
# Basic認証ヘッダ方式は GitHub に拒否されたため（2026-10-05 実測）、URL埋め込みで pull する。remote 設定には保存しない
sudo -u rbot -H env GIT_TERMINAL_PROMPT=0 git -C "$APP" pull --ff-only "https://x-access-token:${TOKEN}@github.com/MKOSAKA/reservation-bot.git" main
unset TOKEN
sudo -u rbot -H bash -c "cd $APP && npm ci && npm run build"
install -m 0644 "$APP/deploy/reservation-bot.service" /etc/systemd/system/reservation-bot.service
systemctl daemon-reload
systemctl restart reservation-bot
sleep 3
systemctl is-active reservation-bot
sudo -u rbot -H bash -c "cd $APP && set -a && . /etc/reservation-bot/config.env && set +a && node dist/src/cli.js next-jobs"
