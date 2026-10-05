/**
 * スタジオル Provider（Milestone 2 で実装）。
 *
 * 2026-10-05 時点の調査メモ（https://studi-ol.com/shop/671 ベースオントップ梅田店）:
 *   - 会員登録（メール+パスワード）必須。予約はカレンダー上の空き（緑）をドラッグして時間範囲を選ぶUI
 *   - 「Web予約では【3か月後の月末】までご予約いただけますが、6時間以上の予約は【半年先】まで（電話のみ）」
 *     → MonthlyWindowReleasePolicy(monthsAhead=3) を想定。解禁の日・時刻は未確認
 *   - 規約 第10条: 短期間の大量予約(3)・システムへの負荷(7)・転売(4) を禁止。自動操作の明示的禁止は無し
 *   - 部屋: 1st(22帖・個人練習不可) / 2st〜4st(12帖) / 5st〜8st(14帖)。2st/5st/8st は30分開始
 */
export const STUDIOL_NOTES = "not implemented (Milestone 2)";
