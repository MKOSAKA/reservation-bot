# AI Agent Instructions

## Governing policy

このリポジトリは株式会社interesのAI開発標準に従います。

正本:
`https://github.com/interes-jp/ai-development-governance`

## Mandatory rules

- 作業前に本ファイルとREADMEを読む
- AIによる変更は専用ブランチで行う
- `main`へ直接pushしない
- 変更前に最新の`main`を取得する
- テストを実行し、結果を報告する
- Secrets、認証情報、本番データを扱わない
- マージ、本番リリース、DB・インフラ・権限変更は人間承認を必須とする
- 変更ファイル、テスト結果、未確認事項、リスクを報告する

### このリポジトリ固有の禁止事項

- CAPTCHA・WAF・アクセス制御を回避するコードを書かない。検知したら停止して通知する
- 対象サイトへ高頻度・並列アクセスしない（解禁直後の再取得は `RELEASE_POLL_BACKOFF` の範囲に限る）
- 予約フローを推測で操作しない。未確認の画面は `FLOW_MAPPED=false` のまま止める
- 予約送信後に結果が不明な場合、他候補へ進まない（二重予約防止）
- storageState・Cookie・パスワード・通知トークンをログ・スクリーンショット・Gitへ出さない

## ドキュメント構成

| 場所 | 用途 | Git追跡 |
|---|---|---|
| `docs/ops/` | 恒久的な運用手順書(runbook) | あり |
| `docs/records/` | 日付付きの作業記録・意思決定記録 | あり |
| `AI-Outputs/` | 探索・下書き（`AI-Outputs/YYYY-MM-DD_<概要>/`） | なし |

### 作業前に必読の文書

- [2026-10-05 調査と設計](docs/records/2026-10-05_調査と設計.md) — 対象サイトの観測結果・規約確認・構成の判断根拠

## Repository-specific information

- Purpose: 予約解禁時刻に希望条件の予約を自動取得する（Provider Adapter方式）
- Framework: なし（Node.js + Playwright）
- Runtime: Node.js 22 / TypeScript
- Package manager: npm
- Test command: `npm test`
- Lint command: `npm run typecheck`
- Build command: `npm run build`
- Deployment environment: 専用VPS/EC2 + systemd（`deploy/`）
- Prohibited operations: 上記「固有の禁止事項」
