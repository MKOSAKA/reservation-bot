/**
 * スタジオルのカレンダー・予約一覧の解釈（純粋関数）。
 *
 * 2026-10-05 観測（ログイン済み）:
 *   - 店舗ページの FullCalendar（.schedule-calendar0、resource = 部屋）を日付移動すると POST /get_schedule_shop で取得
 *   - 空き枠は rendering=background・className "sche-pub" のイベントで、30分ごとに1件（start のみ。title は料金）
 *   - 予約済み・受付外の時間にはイベントが無い（グレー表示）
 *   - 予約可能期間外の日（例: 10/05 時点の 2027-02-02 以降）は、その日のイベントが全部屋で0件
 *   - 未ログインでは空きが表示されない
 *   - 予約一覧（/user）: 「<店名> <部屋> 予約番号：N 予約時間：YYYY年MM月DD日 HH:MM - HH:MM 利用者数：N人 料金：N円」
 */
import { DateTime } from "luxon";
import { ProviderError, TZ, type Slot } from "../../core/types.js";
import type { StudiolFacility } from "./facilities.js";

export interface RawEvent {
  start: string; // "YYYY-MM-DDTHH:mm:ss"
  resourceId: string;
  classes: string[];
  rendering: string | null;
}

export interface RawResource {
  id: string;
  title: string;
}

const SLOT_MIN = 30;

/** 店舗ページの部屋構成が定義と一致するか。違えば SITE_CHANGED */
export function checkResources(facility: StudiolFacility, resources: RawResource[]): void {
  for (const room of Object.values(facility.rooms)) {
    const r = resources.find((x) => x.id === room.resourceId);
    if (!r || r.title.trim() !== room.label) {
      throw new ProviderError("SITE_CHANGED", `room ${room.label} (resource ${room.resourceId}) not found in calendar resources`);
    }
  }
}

/**
 * 対象日の部屋ごとの30分枠を作る。
 * - その日のイベントが全部屋で0件 → 予約可能期間外とみなし not_released
 * - 空きイベントがある時刻 → available、無い時刻 → booked（予約済みまたは受付外）
 */
export function parseDaySlots(facility: StudiolFacility, rooms: string[], events: RawEvent[], date: string): Slot[] {
  const day = DateTime.fromISO(date, { zone: TZ }).startOf("day");
  const dayEvents = events.filter((e) => e.start.startsWith(date));
  const anyForDay = dayEvents.length > 0;
  const slots: Slot[] = [];
  for (const key of rooms) {
    const room = facility.rooms[key];
    if (!room) throw new ProviderError("SITE_CHANGED", `unknown room "${key}"`);
    const free = new Set(
      dayEvents
        .filter((e) => e.resourceId === room.resourceId && e.classes.includes("sche-pub") && e.rendering === "background")
        .map((e) => DateTime.fromISO(e.start, { zone: TZ }).toMillis()),
    );
    for (let t = day; t < day.plus({ days: 1 }); t = t.plus({ minutes: SLOT_MIN })) {
      slots.push({
        spaceKey: key,
        start: t,
        end: t.plus({ minutes: SLOT_MIN }),
        state: !anyForDay ? "not_released" : free.has(t.toMillis()) ? "available" : "booked",
      });
    }
  }
  return slots;
}

export interface UserReservation {
  reservationNo: string;
  shopName: string;
  room: string;
  start: DateTime;
  end: DateTime;
  people: number | null;
  price: number | null;
}

const RES_RE =
  /(\S.*?)\s+(\S+)\s+予約番号：(\d+)\s+予約時間：(\d{4})年(\d{1,2})月(\d{1,2})日\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})(?:\s+利用者数：(\d+)人)?(?:\s+料金：([\d,]+)円)?/;

/** 予約一覧の1件分のテキストを解釈する */
export function parseUserReservation(text: string): UserReservation | null {
  const m = RES_RE.exec(text.replace(/\s+/g, " ").trim());
  if (!m) return null;
  const [, shop, room, no, y, mo, d, s, e, people, price] = m;
  const date = `${y}-${mo!.padStart(2, "0")}-${d!.padStart(2, "0")}`;
  const start = DateTime.fromISO(`${date}T${s!.padStart(5, "0")}`, { zone: TZ });
  let end = DateTime.fromISO(`${date}T${e!.padStart(5, "0")}`, { zone: TZ });
  if (end <= start) end = end.plus({ days: 1 }); // 日をまたぐ予約
  return {
    reservationNo: no!,
    shopName: shop!.trim(),
    room: room!,
    start,
    end,
    people: people ? Number(people) : null,
    price: price ? Number(price.replace(/,/g, "")) : null,
  };
}

/** 確認画面の「合計料金 8300円」 */
export function parseTotal(text: string): number | null {
  const m = /合計料金\s*([\d,]+)\s*円/.exec(text.replace(/\s+/g, " "));
  return m ? Number(m[1]!.replace(/,/g, "")) : null;
}

/** 予約画面のモーダル・hidden の日時表記 "2027/01/31 10:00" */
export function formatStudiolDateTime(dt: DateTime): string {
  return dt.setZone(TZ).toFormat("yyyy/MM/dd HH:mm");
}
