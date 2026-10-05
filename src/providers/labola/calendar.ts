/**
 * LaBOLA 週カレンダーの解釈（純粋関数）。ブラウザ側では DOM から RawRow を抜き出すだけにし、
 * 判定ロジックはここに集約してfixtureでテストする。
 *
 * 2026-10-05 観測（shop 3036 / space 661）:
 *   - 行: <tr><th class="day 日">12/06(日)</th><td class="court">Southコート（屋根有）</td> ...slot cells</tr>
 *   - 空き:      td.slot.link[data-link=".../facility/661/YYYYMMDD-HHMM-HHMM/customer-type/"] 「〇」
 *   - 他者予約:  td.slot.not_allowed.rental_booking  （チーム名表示）
 *   - スクール等: td.slot.not_allowed.facility_usage.disabled
 *   - 未解禁:    td.slot.not_allowed.white 「-」
 *   - 営業時間外: td.slot.not_allowed.excess
 *   - 1列 = 5分（1時間 = colspan 12）。グリッドは 09:00 始まり
 */
import { DateTime } from "luxon";
import { ProviderError, TZ, type Slot, type SlotState } from "../../core/types.js";

export interface RawCell {
  classes: string[];
  colspan: number;
  link: string | null;
  text: string;
}

export interface RawRow {
  dayLabel: string; // "12/13(日)"
  court: string; // "Southコート（屋根有）"
  cells: RawCell[];
}

export interface RawCalendar {
  gridStart: string; // "09:00"
  minutesPerColumn: number; // 5
  rows: RawRow[];
}

const LINK_RE = /\/facility\/(\d+)\/(\d{8})-(\d{4})-(\d{4})\//;

export function classifyCell(c: RawCell): SlotState {
  const has = (k: string) => c.classes.includes(k);
  if (has("link") && c.link) return "available";
  if (has("excess")) return "closed";
  if (has("rental_booking")) return "booked";
  if (has("facility_usage") || has("disabled")) return "blocked";
  if (has("not_allowed") && has("white") && /^[-−–ー]?$/.test(c.text.trim())) return "not_released";
  return "unknown";
}

/**
 * 対象日の行を枠列へ変換する。構造が想定と違えば SITE_CHANGED を投げる。
 * 「空きなし」と「解釈できない」を混同しないため、黙って空配列を返すことはしない。
 */
export function parseDay(cal: RawCalendar, targetDate: string, spaceKey: string, spaceId: number, courtLabel: string): Slot[] {
  if (!/^\d{2}:\d{2}$/.test(cal.gridStart) || !(cal.minutesPerColumn > 0)) {
    throw new ProviderError("SITE_CHANGED", `calendar grid header not recognized (start=${cal.gridStart}, unit=${cal.minutesPerColumn})`);
  }
  if (cal.rows.length === 0) throw new ProviderError("SITE_CHANGED", "calendar has no court rows");
  const d = DateTime.fromISO(targetDate, { zone: TZ });
  const wanted = d.toFormat("MM/dd");
  const row = cal.rows.find((r) => r.dayLabel.startsWith(wanted) && r.court.replace(/\s/g, "").startsWith(courtLabel.replace(/\s/g, "").slice(0, 6)));
  if (!row) throw new ProviderError("SITE_CHANGED", `row for ${wanted} / ${courtLabel} not found`);

  const [gh, gm] = cal.gridStart.split(":").map(Number) as [number, number];
  let cursor = d.set({ hour: gh, minute: gm, second: 0, millisecond: 0 });
  const slots: Slot[] = [];
  for (const cell of row.cells) {
    const span = cell.colspan > 0 ? cell.colspan : 1;
    const start = cursor;
    const end = cursor.plus({ minutes: span * cal.minutesPerColumn });
    cursor = end;
    const state = classifyCell(cell);
    if (state === "closed") continue;
    if (state === "available") {
      const m = LINK_RE.exec(cell.link!);
      if (!m) throw new ProviderError("SITE_CHANGED", `unexpected booking link format`);
      const [, sid, ymd, hs, he] = m;
      const ls = DateTime.fromFormat(`${ymd}${hs}`, "yyyyMMddHHmm", { zone: TZ });
      const le = DateTime.fromFormat(`${ymd}${he}`, "yyyyMMddHHmm", { zone: TZ });
      // 列計算とリンクの時刻が食い違う → グリッド解釈が壊れている
      if (Number(sid) !== spaceId || ls.toMillis() !== start.toMillis() || le.toMillis() !== end.toMillis()) {
        throw new ProviderError("SITE_CHANGED", `grid/link mismatch: grid ${start.toFormat("HH:mm")}-${end.toFormat("HH:mm")} vs link ${hs}-${he} (space ${sid})`);
      }
      slots.push({ spaceKey, start, end, state, ref: cell.link! });
      continue;
    }
    slots.push({ spaceKey, start, end, state });
  }
  if (slots.length === 0) throw new ProviderError("SITE_CHANGED", `no slot cells parsed for ${wanted}`);
  return slots;
}

/** 解禁前の「-」セルは1枠ずつ並ぶが、スクール等は複数時間を1セルで覆う。どちらも時間範囲として扱える。 */
export function priceFor(
  bands: { days: "weekday" | "weekend"; from: string; to: string; yenPerHour: number }[],
  start: DateTime,
  end: DateTime,
  holidays: string[],
): number | null {
  const weekend = start.weekday >= 6 || holidays.includes(start.toISODate()!);
  let total = 0;
  for (let t = start; t < end; t = t.plus({ minutes: 30 })) {
    const hm = t.toFormat("HH:mm");
    const band = bands.find((b) => b.days === (weekend ? "weekend" : "weekday") && hm >= b.from && hm < b.to);
    if (!band) return null;
    total += band.yenPerHour / 2;
  }
  return total;
}
