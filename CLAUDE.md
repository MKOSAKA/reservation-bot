# CLAUDE.md — reservation-bot

作業前に `AGENTS.md`（禁止事項）と `docs/records/` の最新記録を読むこと。回答は日本語。

## 「予約取って」と頼まれたとき（スマホのClaudeアプリ等から）

**`docs/ops/booking-runbook.md`（予約代行の手順書）を読み、その手順どおりに進める。**
要点だけ: 対応はスタジオル梅田のみ（LaBOLA はクラウドから 403 のため手動案内）／人数は毎回聞く／
予約受付の開始日時が過ぎた日は自動予約の対象外／PR はユーザーの「マージして」を待ってマージ／結果は Slack `#予約ボット`。

## リポジトリ構成の要点

- core（Provider非依存）: `src/core/`。サイト固有のURL・DOMは `src/providers/<name>/` に閉じる
- 確定ボタンは `STUDIOL_ALLOW_SUBMIT=1` / `LABOLA_ALLOW_SUBMIT=1`（サーバの `/etc/reservation-bot/config.env`）の時だけ押す。
  2026-10-05 時点: スタジオル 1（ユーザー了承済み）、LaBOLA 0
- インフラ手順: `docs/ops/aws-setup.md`
