/**
 * LaBOLA 施設定義。2026-10-05 に公開ページで確認した値。
 * 出典: https://yoyaku.labola.jp/r/shop/3036/ ・ https://www.sportsoasis.co.jp/futsal-sh18/
 */
import type { ReleaseRule } from "../../core/types.js";

export interface PriceBand {
  /** 適用曜日。weekend は土日祝 */
  days: "weekday" | "weekend";
  from: string; // HH:mm（含む）
  to: string; // HH:mm（含まない）
  yenPerHour: number;
}

export interface LabolaSpace {
  spaceId: number;
  /** カレンダーの行見出し（照合用） */
  label: string;
  prices: PriceBand[];
}

export interface LabolaFacility {
  key: string;
  shopId: number;
  name: string;
  spaces: Record<string, LabolaSpace>;
  release: ReleaseRule;
  /** 祝日（YYYY-MM-DD）。土日祝料金の判定に使う */
  holidays: string[];
}

export const LABOLA_FACILITIES: Record<string, LabolaFacility> = {
  morinomiya: {
    key: "morinomiya",
    shopId: 3036,
    name: "ルネサンスもりのみやキューズモール24（フットサル）",
    spaces: {
      covered: {
        spaceId: 661,
        label: "Southコート（屋根有）",
        prices: [
          { days: "weekday", from: "10:30", to: "18:30", yenPerHour: 8800 },
          { days: "weekday", from: "18:30", to: "22:30", yenPerHour: 11000 },
          { days: "weekend", from: "00:00", to: "24:00", yenPerHour: 11000 },
        ],
      },
      open: {
        spaceId: 660,
        label: "Northコート（屋根無）",
        prices: [
          { days: "weekday", from: "10:30", to: "18:30", yenPerHour: 6600 },
          { days: "weekday", from: "18:30", to: "22:30", yenPerHour: 8800 },
          { days: "weekend", from: "00:00", to: "24:00", yenPerHour: 8800 },
        ],
      },
    },
    // 公式案内は「利用日の2か月前から」。2026-10-05 の観測では 12/04 まで受付・12/05 未解禁で「60日前」と整合。
    // 解禁時刻（0:00 か否か）は 10/05 23:50 と 10/06 00:03 の観測で確定させる（docs/records 参照）。
    release: { type: "days_before", days: 60, time: "00:00", timezone: "Asia/Tokyo" },
    holidays: ["2026-11-03", "2026-11-23", "2027-01-01", "2027-01-11", "2027-02-11", "2027-02-23", "2027-03-21"],
  },
};
