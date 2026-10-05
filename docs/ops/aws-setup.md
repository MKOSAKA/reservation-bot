# AWS 環境の構築・運用手順

対象: 株式会社interes の AWS アカウント（ap-northeast-1）。構築・変更は人間の承認後に実行する。

## 構成

- EC2 t4g.small（Ubuntu 24.04 arm64）。**通常は停止**。EventBridge Scheduler の1回限りスケジュールで必要時のみ起動
  - 起動: 各リクエストの T-24h と T0 の60分前、T0 の30分前に再試行（起動済みなら無害）
  - 停止: デーモンが「75分以内に予定なし・実行中なし・起動から20分経過・keepalive なし」で自インスタンスを停止
- SSH なし。接続は SSM Session Manager のみ。IMDSv2 必須（hop limit 1）。EBS 暗号化
- 公開IPv4は自動割当（EIPを使わないので停止中は課金されない）
- 秘密情報: Secrets Manager `reservation-bot/app`（LaBOLA・セキュリティコード・Slack・暗号鍵）と
  `reservation-bot/deploy-github-token`（リポジトリ読み取り用 PAT）。起動ごとに `/etc/reservation-bot/secrets.env`(0640) へ展開
- IAM: インスタンスロールは自分の秘密情報の読み取り、`reservation-bot` グループのスケジュール操作、
  タグ `Project=reservation-bot` のインスタンス停止のみ。起動用ロール（scheduler 用）は当該インスタンスの StartInstances のみ

## 初回構築

1. GitHub で fine-grained PAT を発行（Repository: `MKOSAKA/reservation-bot` のみ / Contents: Read-only / 期限1年）
2. 手元の Mac で秘密情報を登録（値は表示されない）
   ```bash
   AWS_REGION=ap-northeast-1 bash infra/scripts/put-secrets.sh
   ```
3. スタック作成（VPC とパブリックサブネットを指定）
   ```bash
   aws cloudformation deploy --region ap-northeast-1 --stack-name reservation-bot \
     --template-file infra/cloudformation.yaml --capabilities CAPABILITY_NAMED_IAM \
     --parameter-overrides VpcId=<vpc-id> SubnetId=<public-subnet-id>
   ```
4. 初回起動で UserData → `bootstrap.sh` が実行される（10分程度）。Slack に「🟢 起動しました」が届けば完了
   - ログ: `/var/log/reservation-bot-userdata.log`、`journalctl -u reservation-bot`

## リクエスト登録（通常: GitHub Actions 経由）

`config/requests/<id>.yaml` を PR で main に入れると、`.github/workflows/register-requests.yml` が
OIDC で AWS ロール `reservation-bot-github-actions` を引き受け、サーバ起動 → `infra/scripts/register.sh` → Slack 通知まで行う。

初回のみ GitHub のリポジトリ設定 → Secrets and variables → Actions → **Variables** に登録する（秘密情報ではない）:

| 変数 | 値 |
|---|---|
| `RB_INSTANCE_ID` | スタック出力 `InstanceId` |
| `RB_AWS_ROLE_ARN` | スタック出力 `GitHubActionsRoleArn` |

アカウントに GitHub の OIDC プロバイダが既にあるか確認し、あればスタック作成時に `CreateGitHubOidcProvider=false` を渡す:
`aws iam list-open-id-connect-providers`

## リクエスト登録（手動・保守用）

```bash
aws ssm start-session --target <instance-id>
sudo -u rbot -H bash -c 'cd /opt/reservation-bot && set -a && . /etc/reservation-bot/config.env && . /etc/reservation-bot/secrets.env && set +a \
  && node dist/src/cli.js add config/requests/2026-12-13-morinomiya.yaml && node dist/src/cli.js next-jobs'
```

`add` が起動スケジュールを登録する。臨時起動は `node dist/src/cli.js wake-at 2026-10-11T23:30`。

## 手作業中に停止させない

`touch /var/lib/reservation-bot/keepalive`（作業後に削除）

## デプロイ（手動）

```bash
aws ssm send-command --instance-ids <instance-id> --document-name AWS-RunShellScript \
  --parameters 'commands=["bash /opt/reservation-bot/infra/scripts/deploy.sh"]'
```

## 確定ボタンの有効化

実予約テスト合格後に `/etc/reservation-bot/config.env` の `LABOLA_ALLOW_SUBMIT=1` へ変更し、`systemctl restart reservation-bot`。

## 費用の目安（概算）

稼働は月数時間。EBS 16GB（約$1.5/月）＋稼働時間分のインスタンス・公開IPv4。Secrets Manager 2件（約$0.8/月）。
