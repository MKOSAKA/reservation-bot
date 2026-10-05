import { readFileSync } from "node:fs";
import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { ProviderError, TZ } from "../src/core/types.js";
import { resolveCandidateSlots } from "../src/core/slots.js";
import { classifyCell, parseDay, priceFor, type RawCalendar, type RawCell } from "../src/providers/labola/calendar.js";
import { LABOLA_FACILITIES } from "../src/providers/labola/facilities.js";
import { categorizeResponse } from "../src/providers/labola/adapter.js";

const observed = JSON.parse(readFileSync(new URL("./fixtures/labola-3036-661-week-2026-11-30.json", import.meta.url), "utf8")) as RawCalendar;
const covered = LABOLA_FACILITIES.morinomiya!.spaces.covered!;

/** 実観測の「日曜・未解禁」行のセルを、解禁後の姿（空き/他者予約）へ置き換えた合成データ */
function releasedSunday(date: string, bookedStarts: string[]): RawCalendar {
  const d = DateTime.fromISO(date, { zone: TZ });
  const ymd = d.toFormat("yyyyMMdd");
  const cells: RawCell[] = [{ classes: ["slot", "not_allowed", "excess"], colspan: 6, link: null, text: "" }];
  for (let h = 9; h <= 19; h++) {
    const s = `${String(h).padStart(2, "0")}30`;
    const e = `${String(h + 1).padStart(2, "0")}30`;
    const hm = `${s.slice(0, 2)}:${s.slice(2)}`;
    cells.push(
      bookedStarts.includes(hm)
        ? { classes: ["slot", "not_allowed", "rental_booking", "white"], colspan: 12, link: null, text: "FC" }
        : { classes: ["slot", "link", "empty"], colspan: 12, link: `https://yoyaku.labola.jp/r/booking/rental/shop/3036/facility/661/${ymd}-${s}-${e}/customer-type/`, text: "〇" },
    );
  }
  cells.push({ classes: ["slot", "not_allowed", "excess"], colspan: 30, link: null, text: "" });
  return { gridStart: "09:00", minutesPerColumn: 5, rows: [{ dayLabel: d.toFormat("MM/dd(ccc)"), court: covered.label, cells }] };
}

describe("labola calendar (observed fixture)", () => {
  it("parses a weekday with free / school / booked cells", () => {
    const slots = parseDay(observed, "2026-11-30", "covered", 661, covered.label);
    const fmt = slots.map((s) => `${s.start.toFormat("HH:mm")}-${s.end.toFormat("HH:mm")}:${s.state}`);
    expect(fmt).toEqual([
      "10:30-11:30:available",
      "11:30-12:30:available",
      "12:30-13:30:available",
      "13:30-14:30:available",
      "14:30-15:30:available",
      "15:30-16:30:available",
      "16:30-19:30:blocked",
      "19:30-20:30:available",
      "20:30-21:30:available",
      "21:30-22:30:booked",
    ]);
  });

  it("treats unreleased future days as not_released (not as booked)", () => {
    const slots = parseDay(observed, "2026-12-06", "covered", 661, covered.label);
    expect(slots).toHaveLength(11);
    expect(slots.every((s) => s.state === "not_released")).toBe(true);
    expect(slots[0]!.start.toFormat("HH:mm")).toBe("09:30");
  });

  it("throws SITE_CHANGED when the row is missing (never 'no availability')", () => {
    expect(() => parseDay(observed, "2026-12-13", "covered", 661, covered.label)).toThrowError(ProviderError);
    try {
      parseDay(observed, "2026-12-13", "covered", 661, covered.label);
    } catch (e) {
      expect((e as ProviderError).category).toBe("SITE_CHANGED");
    }
  });

  it("throws SITE_CHANGED when grid math and link times disagree", () => {
    const broken: RawCalendar = { ...observed, gridStart: "09:30" };
    expect(() => parseDay(broken, "2026-11-30", "covered", 661, covered.label)).toThrow(/grid\/link mismatch/);
  });

  it("throws SITE_CHANGED when the table is absent", () => {
    expect(() => parseDay({ gridStart: "", minutesPerColumn: 0, rows: [] }, "2026-11-30", "covered", 661, covered.label)).toThrow(ProviderError);
  });

  it("resolves a 2-hour candidate to two consecutive free slots", () => {
    const cal = releasedSunday("2026-12-13", ["11:30"]);
    const slots = parseDay(cal, "2026-12-13", "covered", 661, covered.label);
    const mk = (hm: string) => {
      const start = DateTime.fromISO(`2026-12-13T${hm}`, { zone: TZ });
      return { rank: 1, spaceKey: "covered", start, end: start.plus({ minutes: 120 }), label: hm };
    };
    expect(resolveCandidateSlots(slots, mk("13:30"))!.map((s) => s.state)).toEqual(["available", "available"]);
    expect(resolveCandidateSlots(slots, mk("11:30"))!.some((s) => s.state === "booked")).toBe(true);
    expect(resolveCandidateSlots(slots, mk("13:00"))).toBeNull(); // :30 区切りの枠と合わない
  });

  it("classifies cells", () => {
    expect(classifyCell({ classes: ["slot", "not_allowed", "white"], colspan: 12, link: null, text: "-" })).toBe("not_released");
    expect(classifyCell({ classes: ["slot", "weird"], colspan: 12, link: null, text: "?" })).toBe("unknown");
  });
});

describe("labola pricing", () => {
  const f = LABOLA_FACILITIES.morinomiya!;
  const at = (iso: string) => DateTime.fromISO(iso, { zone: TZ });
  it("Sunday covered 2h = 22,000", () => {
    expect(priceFor(covered.prices, at("2026-12-13T13:30"), at("2026-12-13T15:30"), f.holidays)).toBe(22000);
  });
  it("weekday covered across the 18:30 boundary", () => {
    expect(priceFor(covered.prices, at("2026-11-30T17:30"), at("2026-11-30T19:30"), f.holidays)).toBe(8800 + 11000);
  });
  it("holiday uses weekend price", () => {
    expect(priceFor(covered.prices, at("2026-11-23T13:30"), at("2026-11-23T14:30"), f.holidays)).toBe(11000);
  });
});

describe("response categorization", () => {
  it("separates 429 / 403 / 5xx / CAPTCHA / CSRF", () => {
    expect(categorizeResponse(429, "")!.category).toBe("RATE_LIMITED");
    expect(categorizeResponse(403, "")!.category).toBe("FORBIDDEN");
    expect(categorizeResponse(503, "")!.category).toBe("SERVER_ERROR");
    expect(categorizeResponse(200, "reCAPTCHA")!.category).toBe("CAPTCHA");
    expect(categorizeResponse(403, "CSRF verification failed")!.category).toBe("FORBIDDEN");
    expect(categorizeResponse(200, "ok")).toBeNull();
  });
});
