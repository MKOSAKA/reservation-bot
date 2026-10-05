#!/bin/bash
# サーバ上で予約リクエストを登録する（SSM で root 実行。GitHub Actions から呼ばれる）
#   register.sh config/requests/a.yaml [config/requests/b.yaml ...]
# main を取り込むだけで再ビルド・再起動はしない（動作中のデーモンを止めないため）。
# デーモンは DB を毎秒見ているので、登録したフェーズは再起動なしで拾われる。
set -euo pipefail
APP=/opt/reservation-bot
AWS=$(command -v aws || echo /snap/bin/aws)
[ $# -ge 1 ] || { echo "usage: register.sh <request.yaml...>" >&2; exit 2; }

TOKEN=$("$AWS" secretsmanager get-secret-value --secret-id reservation-bot/deploy-github-token --query SecretString --output text)
# Basic認証ヘッダ方式は GitHub に拒否されたため（2026-10-05 実測）、URL埋め込みで pull する。remote 設定には保存しない
sudo -u rbot -H env GIT_TERMINAL_PROMPT=0 git -C "$APP" pull --ff-only "https://x-access-token:${TOKEN}@github.com/MKOSAKA/reservation-bot.git" main
unset TOKEN

for f in "$@"; do
  [[ "$f" =~ ^config/requests/[a-z0-9-]+\.yaml$ ]] || { echo "skip: $f (config/requests/<id>.yaml のみ)"; continue; }
  sudo -u rbot -H bash -c "cd $APP && set -a && . /etc/reservation-bot/config.env && . /etc/reservation-bot/secrets.env && set +a && node dist/src/cli.js add '$f'"
done
