import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { candidatesFor } from "../src/core/reservation-engine.js";
import { policyFor } from "../src/core/release-policy.js";
import { ProviderError, TZ, type ReservationRequest } from "../src/core/types.js";
import { SessionManager } from "../src/core/session-manager.js";
import { StudiolAdapter } from "../src/providers/studiol/adapter.js";
import { STUDIOL_FACILITIES } from "../src/providers/studiol/facilities.js";
import { checkResources, formatStudiolDateTime, parseDaySlots, parseTotal, parseUserReservation, type RawEvent } from "../src/providers/studiol/parse.js";

const f = STUDIOL_FACILITIES["base-on-top-umeda"]!;
const at = (iso: string) => DateTime.fromISO(iso, { zone: TZ });

/** 2026-10-05 に観測した形（sche-pub の背景イベントが30分ごと）を再現 */
function ev(date: string, hm: string, rid: string): RawEvent {
  return { start: `${date}T${hm}:00`, resourceId: rid, classes: ["sche-pub"], rendering: "background" };
}

describe("studiol calendar", () => {
  it("free 30-min events become available slots, gaps become booked", () => {
    const events = [ev("2027-01-31", "13:00", "2854"), ev("2027-01-31", "13:30", "2854"), ev("2027-01-31", "14:00", "2854")];
    const slots = parseDaySlots(f, ["1st"], events, "2027-01-31");
    const st = (hm: string) => slots.find((s) => s.start.toFormat("HH:mm") === hm)!.state;
    expect(slots).toHaveLength(48);
    expect(st("13:00")).toBe("available");
    expect(st("14:00")).toBe("available");
    expect(st("14:30")).toBe("booked");
  });

  it("a day with no events at all is treated as not released (beyond the booking window)", () => {
    const slots = parseDaySlots(f, ["1st", "8st"], [], "2027-02-02");
    expect(slots.every((s) => s.state === "not_released")).toBe(true);
  });

  it("detects a changed room layout", () => {
    expect(() => checkResources(f, [{ id: "2854", title: "1st" }])).toThrow(ProviderError);
    const all = Object.values(f.rooms).map((r) => ({ id: r.resourceId, title: r.label }));
    expect(() => checkResources(f, all)).not.toThrow();
  });
});

describe("studiol parsing", () => {
  it("parses a reservation in /user (observed format)", () => {
    const r = parseUserReservation(" ベースオントップ【バンド】大阪 梅田店 1st 予約番号：8138887 予約時間：2026年10月18日 13:00 - 15:00 利用者数：10人 料金：8300円 予約の延長 オンライン決済 予約のキャンセル ")!;
    expect(r.room).toBe("1st");
    expect(r.reservationNo).toBe("8138887");
    expect(r.start.toISO()).toBe("2026-10-18T13:00:00.000+09:00");
    expect(r.end.toFormat("HH:mm")).toBe("15:00");
    expect(r.people).toBe(10);
    expect(r.price).toBe(8300);
    expect(r.shopName.startsWith("ベースオントップ")).toBe(true);
  });
  it("parses totals and formats modal datetimes", () => {
    expect(parseTotal("ご予約について いいえ 合計料金 8300円 上記の内容で予約を確定する")).toBe(8300);
    expect(formatStudiolDateTime(at("2027-01-31T10:00"))).toBe("2027/01/31 10:00");
  });
});

describe("studiol candidates", () => {
  const adapter = new StudiolAdapter(new SessionManager("studiol", "/tmp/rb-test-state"), "/tmp/rb-test-ev", () => null);
  const req: ReservationRequest = {
    id: "x",
    provider: "studiol",
    facility: "base-on-top-umeda",
    targetDate: "2027-02-13",
    durationMinutes: 120,
    preferences: { spacePriority: ["1st", "8st", "7st"], timePriority: ["14:00", "13:00", "16:00"], timeFirst: false, people: 6, earliestStart: "12:00", latestEnd: "18:00" },
    maxPrice: null,
    release: f.release,
    mode: "dry-run",
    status: "scheduled",
  };

  it("shifts :00 starts to :30 for 30-minute rooms and keeps the 12:00-18:00 window", () => {
    const labels = candidatesFor(req, adapter).map((c) => c.label);
    expect(labels).toEqual([
      "1st 14:00-16:00",
      "1st 13:00-15:00",
      "1st 16:00-18:00",
      "8st 14:30-16:30",
      "8st 13:30-15:30",
      // 8st 16:30-18:30 は 18:00 を超えるので除外
      "7st 14:00-16:00",
      "7st 13:00-15:00",
      "7st 16:00-18:00",
    ]);
  });

  it("monthly window release (provisional): Feb 2027 opens on 2026-11-01 00:00", () => {
    expect(policyFor(f.release).releaseAt("2027-02-13").toISO()).toBe("2026-11-01T00:00:00.000+09:00");
  });
});

describe("studiol login failure detail", () => {
  it("keeps status, path and on-page messages while masking the credentials", async () => {
    const { describeLoginFailure } = await import("../src/providers/studiol/adapter.js");
    const s = describeLoginFailure(
      200,
      "https://studi-ol.com/shop/671?x=secret",
      "ベースオントップ | スタジオル",
      ["メールアドレス user@example.com またはパスワードが違います", "メールアドレス user@example.com またはパスワードが違います", "p@ss"],
      { email: "user@example.com", password: "p@ss" },
    );
    expect(s).toContain("status=200");
    expect(s).toContain("url=https://studi-ol.com/shop/671");
    expect(s).not.toContain("secret");
    expect(s).not.toContain("user@example.com");
    expect(s).not.toContain("p@ss");
    expect(s.match(/パスワードが違います/g)).toHaveLength(1);
  });
});

describe("studiol schedule request matching", () => {
  it("matches only the request for the target date", async () => {
    const { isScheduleRequestFor } = await import("../src/providers/studiol/adapter.js");
    const body = (d: string, e: string) => `_token=abc&shop_id=671&start=${encodeURIComponent(`${d} 00:00:00`)}&end=${encodeURIComponent(`${e} 07:00:00`)}`;
    expect(isScheduleRequestFor(body("2027-01-30", "2027-01-31"), "2027-01-30")).toBe(true);
    expect(isScheduleRequestFor(body("2027-01-30", "2027-01-31").replace(/%20/g, "+"), "2027-01-30")).toBe(true);
    // 店舗ページを開いた直後の「今日」の取得には反応しない（終了日に対象日が入っていても）
    expect(isScheduleRequestFor(body("2027-01-29", "2027-01-30"), "2027-01-30")).toBe(false);
    expect(isScheduleRequestFor(JSON.stringify({ start: "2027-01-30 00:00:00" }), "2027-01-30")).toBe(true);
    expect(isScheduleRequestFor(null, "2027-01-30")).toBe(false);
  });
});
