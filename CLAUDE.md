# CLAUDE.md — reservation-bot

作業前に `AGENTS.md`（禁止事項）と `docs/records/` の最新記録を読むこと。回答は日本語。

## 「予約取って」と頼まれたとき（スマホのClaudeアプリ等から）

ユーザーは PC を使わずにチャットで依頼する。次の順で進める。

1. **条件を解釈する**: 施設・日付・開始時刻の希望順・利用時間・コート/部屋・料金上限
   - 対応施設とキーは `src/config/resolve.ts` の `CATALOG`（現状 LaBOLA `morinomiya`: `covered`=Southコート屋根有 / `open`=Northコート屋根無）
   - 未対応の施設（例: スタジオル ベースオントップ梅田）は「未対応」と伝え、登録しない
   - 森ノ宮の枠は :30 開始（日曜 9:30〜）。「13時から」のように枠に合わない時刻は、近い枠（12:30 / 13:30）を提案して確認する
   - 料金上限の既定: 屋根付き土日祝 11,000円/h、平日 8,800円/h（18:30以降 11,000円/h）
2. **解禁日時を計算して確認を取る**: `npx tsx src/cli.ts validate <file>` の出力（解禁日時・候補・警告）をそのまま見せ、
   「この内容で登録してよいか」を聞く。mode は原則 `auto`（ただし実予約テスト合格前は `assist`。`docs/records` で状況を確認）
3. **PR を作る**: ブランチ `ai/claude/request-<id>`、ファイル `config/requests/<id>.yaml`（id = ファイル名。例 `2026-12-20-morinomiya`）
4. **ユーザーの「マージして」を待ってマージする**（`governance/AI_AGENT_POLICY.md`。包括的な「任せる」では代行しない）
5. マージで GitHub Actions `register-requests` が動き、サーバ起動 → 登録 → Slack 通知。Actions の結果を確認して報告する
   - 失敗時はログ（`get-command-invocation` の出力）を見て原因を伝える。サーバへの再実行は `workflow_dispatch` で行える

取り消し・変更はまだ CLI のみ（サーバ上）。必要になったら機能追加を提案する。

## リポジトリ構成の要点

- core（Provider非依存）: `src/core/`。サイト固有のURL・DOMは `src/providers/<name>/` に閉じる
- 確定ボタンは `LABOLA_ALLOW_SUBMIT=1`（サーバの `/etc/reservation-bot/config.env`）の時だけ押す
- インフラ手順: `docs/ops/aws-setup.md`
