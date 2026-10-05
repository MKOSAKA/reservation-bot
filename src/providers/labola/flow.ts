/**
 * LaBOLA 予約フローの画面判定と、予約一覧の解析（純粋関数）。
 * 2026-10-05 にユーザー本人のログイン済みブラウザで STEP4 まで観測（確定は未実施）。
 *
 *   customer-type  … 未ログインならログインフォーム。ログイン済みなら STEP1 へ遷移
 *   STEP1 booking-info      「スペース予約｜予約内容の選択」 select[name=start|end] / [name=submit_conf]
 *   STEP2                   予約者情報（登録情報の確認）
 *   STEP3 customer-payment  「スペース予約｜お支払い方法の選択」 ZEUS: zeus_card_option=prev + 登録カードのCVV / [name=submit_ok]
 *   STEP4 customer-confirm  「スペース予約｜内容確認」 agree-tos / agree-pp / [name=submit_ok]「この内容で申込む」
 *   STEP5                   予約完了（未観測）
 */
import { DateTime } from "luxon";
import { TZ } from "../../core/types.js";

export type FlowStep = "login" | "step1" | "step2" | "step3" | "step4" | "complete" | "three_ds" | "unknown";

export function identifyStep(title: string, path: string, hasLoginForm: boolean, bodyText: string): FlowStep {
  if (hasLoginForm) return "login";
  if (/本人認証|3-?D\s?セキュア|3D Secure|ワンタイムパスワード/i.test(bodyText) && !/お支払い方法の選択/.test(title)) return "three_ds";
  if (/予約内容の選択/.test(title) || /\/booking-info\//.test(path)) return "step1";
  if (/お支払い方法/.test(title) || /\/customer-payment\//.test(path)) return "step3";
  if (/内容確認/.test(title) || /\/customer-confirm\//.test(path)) return "step4";
  if (/予約完了|完了/.test(title) || /\/complete/.test(path)) return "complete";
  if (/予約者情報/.test(title)) return "step2";
  return "unknown";
}

/** 枠が埋まった・受付不可を示す文言。表示されたら SLOT_TAKEN として次候補へ */
export const SLOT_TAKEN_PATTERNS = [/既に予約/, /予約済み/, /空きがありません/, /予約できません/, /選択された時間.*(利用|予約)できません/, /満席/];

export function looksSlotTaken(bodyText: string): boolean {
  return SLOT_TAKEN_PATTERNS.some((p) => p.test(bodyText));
}

/** "金額 17,600 円" → 17600 */
export function parseAmount(text: string): number | null {
  const m = /金額\s*([\d,]+)\s*円/.exec(text.replace(/\s+/g, " "));
  return m ? Number(m[1]!.replace(/,/g, "")) : null;
}

export interface BookingRow {
  href: string;
  text: string;
}

export interface ParsedBooking {
  detailPath: string;
  start: DateTime;
  end: DateTime;
  spaceLabel: string;
  price: number | null;
  cancelled: boolean;
}

/**
 * 予約一覧の1行を解釈する。
 * 例: "… 2026/11/01 (日) 14:30 - 16:30｜Northコート（屋根無） 17,600円 予約完了 詳細確認"
 */
export function parseBookingRow(row: BookingRow): ParsedBooking | null {
  const t = row.text.replace(/\s+/g, " ");
  const m = /(\d{4})\/(\d{2})\/(\d{2})\s*\(.\)\s*(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s*｜\s*([^\s]+)/.exec(t);
  if (!m) return null;
  const [, y, mo, d, s, e, space] = m;
  const pad = (hm: string) => hm.padStart(5, "0");
  const start = DateTime.fromISO(`${y}-${mo}-${d}T${pad(s!)}`, { zone: TZ });
  const end = DateTime.fromISO(`${y}-${mo}-${d}T${pad(e!)}`, { zone: TZ });
  const p = /([\d,]+)円/.exec(t.slice(m.index + m[0].length));
  return {
    detailPath: row.href,
    start,
    end,
    spaceLabel: space!,
    price: p ? Number(p[1]!.replace(/,/g, "")) : null,
    cancelled: /キャンセル(?!について)/.test(t.slice(m.index + m[0].length)) && !/予約完了/.test(t),
  };
}

/** 予約詳細の「予約番号 15198」 */
export function parseReservationNumber(text: string): string | null {
  const m = /予約番号\s*(\d+)/.exec(text.replace(/\s+/g, " "));
  return m ? m[1]! : null;
}
