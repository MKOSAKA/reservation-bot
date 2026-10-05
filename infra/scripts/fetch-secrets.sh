#!/bin/bash
# Secrets Manager の reservation-bot/app を /etc/reservation-bot/secrets.env へ展開する（root で実行）。
# systemd の ExecStartPre から毎回呼ばれるため、Secrets Manager を更新すれば再起動で反映される。
set -euo pipefail
ETC=/etc/reservation-bot
AWS=$(command -v aws || echo /snap/bin/aws)
umask 077
TMP=$(mktemp)
"$AWS" secretsmanager get-secret-value --secret-id reservation-bot/app --query SecretString --output text \
  | python3 -c '
import json, sys
d = json.load(sys.stdin)
allowed = ["LABOLA_MEMBER_ID", "LABOLA_PASSWORD", "LABOLA_CARD_CVV", "STATE_ENCRYPTION_KEY", "SLACK_WEBHOOK_URL", "LINE_CHANNEL_ACCESS_TOKEN", "LINE_TO_USER_ID"]
for k in allowed:
    v = d.get(k)
    if v is None: continue
    if "\n" in v: raise SystemExit(f"{k} contains newline")
    print(f"{k}={v}")
' > "$TMP"
install -o root -g rbot -m 0640 "$TMP" "$ETC/secrets.env"
rm -f "$TMP"
