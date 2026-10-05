/**
 * スタジオル施設定義。2026-10-05 にユーザー本人のログイン済みブラウザで確認した値。
 * 出典: https://studi-ol.com/shop/671（FullCalendar の resources）
 */
import type { ReleaseRule } from "../../core/types.js";

export interface StudiolRoom {
  resourceId: string;
  label: string;
  /** 開始可能な分（0: 毎時 :00 開始 / 30: 毎時 :30 開始） */
  startMinute: 0 | 30;
}

export interface StudiolFacility {
  key: string;
  shopId: number;
  name: string;
  rooms: Record<string, StudiolRoom>;
  defaultPeople: number;
  /** 「Web予約では3か月後の月末まで」。解禁の日・時刻は未観測（docs/records 参照） */
  release: ReleaseRule;
}

export const STUDIOL_FACILITIES: Record<string, StudiolFacility> = {
  "base-on-top-umeda": {
    key: "base-on-top-umeda",
    shopId: 671,
    name: "ベースオントップ【バンド】大阪 梅田店",
    rooms: {
      "1st": { resourceId: "2854", label: "1st", startMinute: 0 },
      "2st": { resourceId: "2855", label: "2st", startMinute: 30 },
      "3st": { resourceId: "2856", label: "3st", startMinute: 0 },
      "4st": { resourceId: "2857", label: "4st", startMinute: 0 },
      "5st": { resourceId: "2858", label: "5st", startMinute: 30 },
      "6st": { resourceId: "2859", label: "6st", startMinute: 0 },
      "7st": { resourceId: "2860", label: "7st", startMinute: 0 },
      "8st": { resourceId: "2861", label: "8st", startMinute: 30 },
    },
    defaultPeople: 8,
    // 未検証の仮置き: 毎月1日 0:00 に「3か月後の月末」まで開くと仮定。11/1 前後の観測で確定させる
    release: { type: "monthly_window", monthsAhead: 3, openDay: 1, time: "00:00", timezone: "Asia/Tokyo" },
  },
};
