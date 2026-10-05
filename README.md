# reservation-bot

予約解禁時刻に、PCの前で待機しなくても希望条件の予約を取るための常駐型予約自動化基盤。
サイトごとの差異は Provider Adapter に閉じ込め、core（スケジューラ・候補フォールバック・二重予約防止・通知・証跡）は共通。

## 構成

```
src/
  core/        types / release-policy / candidates / slots / reservation-engine / scheduler / session-manager / notification / logger
  providers/   labola/（実装中）  studiol/（Milestone 2）
  config/      予約リクエスト YAML の検証
  storage/     SQLite（状態遷移・試行履歴・予約・フェーズ）
config/requests/  予約リクエスト（YAML）
deploy/           systemd unit
docs/records/     調査・設計の記録
```

## 使い方

```bash
npm ci
npm test

# リクエスト登録（解禁日時とフェーズが計画される）
npx tsx src/cli.ts add config/requests/2026-12-13-morinomiya.yaml
npx tsx src/cli.ts next-jobs

# 手動実行
npx tsx src/cli.ts run 2026-12-13-morinomiya --mode dry-run   # 空き確認のみ
npx tsx src/cli.ts run 2026-12-13-morinomiya --mode assist    # 確認画面で停止
npx tsx src/cli.ts status 2026-12-13-morinomiya

# 常駐（本番は systemd）
npx tsx src/cli.ts daemon
```

## モード

| mode | 動作 |
|---|---|
| dry-run | 空き確認のみ。状態を変えない |
| assist | 予約確認画面まで進んで停止 |
| auto | 確定まで実行。`running` へのロック取得に成功した1プロセスのみ |

## 状態

`draft → scheduled → preflight_ok → running → completed / failed / manual_intervention_required`（`cancelled`）

## 秘密情報

`.env` と `data/` は Git 管理外。本番は Secrets Manager から systemd の EnvironmentFile へ展開する。
storageState は 0600 で保存し、`STATE_ENCRYPTION_KEY` があれば AES-256-GCM で暗号化する。
