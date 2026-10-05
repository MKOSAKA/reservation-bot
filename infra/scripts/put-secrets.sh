#!/bin/bash
# 手元の Mac で実行し、Secrets Manager に秘密情報を登録・更新する。
# 値は画面に表示せず、シェル履歴にも残さない（read -s）。
set -euo pipefail
REGION=${AWS_REGION:-ap-northeast-1}

ask() { local v; read -r -s -p "$1: " v; echo >&2; printf '%s' "$v"; }

upsert() {
  local id=$1 value=$2
  if aws secretsmanager describe-secret --region "$REGION" --secret-id "$id" >/dev/null 2>&1; then
    aws secretsmanager put-secret-value --region "$REGION" --secret-id "$id" --secret-string "$value" >/dev/null
  else
    aws secretsmanager create-secret --region "$REGION" --name "$id" --secret-string "$value" \
      --tags Key=Project,Value=reservation-bot >/dev/null
  fi
  echo "updated: $id"
}

echo "== reservation-bot/deploy-github-token（GitHub fine-grained PAT: MKOSAKA/reservation-bot の Contents: Read-only のみ）"
upsert reservation-bot/deploy-github-token "$(ask 'PAT')"

echo "== reservation-bot/app"
MEMBER=$(ask 'LaBOLA メールアドレス')
PASS=$(ask 'LaBOLA パスワード')
CVV=$(ask '登録カードのセキュリティコード')
SLACK=$(ask 'Slack Incoming Webhook URL')
KEY=$(openssl rand -base64 32)
JSON=$(MEMBER="$MEMBER" PASS="$PASS" CVV="$CVV" SLACK="$SLACK" KEY="$KEY" python3 -c '
import json, os
print(json.dumps({"LABOLA_MEMBER_ID": os.environ["MEMBER"], "LABOLA_PASSWORD": os.environ["PASS"],
  "LABOLA_CARD_CVV": os.environ["CVV"], "SLACK_WEBHOOK_URL": os.environ["SLACK"], "STATE_ENCRYPTION_KEY": os.environ["KEY"]}))')
upsert reservation-bot/app "$JSON"
unset MEMBER PASS CVV SLACK KEY JSON
