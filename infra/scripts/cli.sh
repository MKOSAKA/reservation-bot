#!/bin/bash
# サーバ上で CLI を rbot ユーザー・本番の環境変数で実行する（SSM から root で呼ぶ）
#   bash /opt/reservation-bot/infra/scripts/cli.sh next-jobs
#   bash /opt/reservation-bot/infra/scripts/cli.sh session-check
#   bash /opt/reservation-bot/infra/scripts/cli.sh preflight 2026-12-13-morinomiya
# 作業中にインスタンスが自動停止しないよう、keepalive を置く（作業後は keepalive off）
set -euo pipefail
APP=/opt/reservation-bot
DATA=/var/lib/reservation-bot
case "${1:-}" in
  keepalive) touch "$DATA/keepalive"; chown rbot:rbot "$DATA/keepalive"; echo "keepalive on"; exit 0 ;;
  keepalive-off) rm -f "$DATA/keepalive"; echo "keepalive off"; exit 0 ;;
  status) systemctl is-active reservation-bot; journalctl -u reservation-bot -n 20 --no-pager -o cat | cut -c1-200; exit 0 ;;
esac
args=()
for a in "$@"; do
  [[ "$a" =~ ^[A-Za-z0-9_./:-]+$ ]] || { echo "invalid argument: $a" >&2; exit 2; }
  args+=("$a")
done
sudo -u rbot -H bash -c "cd $APP && set -a && . /etc/reservation-bot/config.env && . /etc/reservation-bot/secrets.env && set +a && node dist/src/cli.js ${args[*]}" 2>&1 | grep -v '^{"level"' || true
