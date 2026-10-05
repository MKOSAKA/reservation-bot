/**
 * 予約解禁日時の計算（Strategy）。すべて Asia/Tokyo で計算する。
 *
 * - DaysBefore: 利用日の N 日前の指定時刻に解禁（LaBOLA 森ノ宮は 60日前 0:00 と推定。docs/records 参照）
 * - MonthlyWindow: 毎月 openDay 日の指定時刻に「monthsAhead か月後の月末」までが解禁（スタジオル型）
 * - Fixed: 解禁日時を直接指定
 */
import { DateTime } from "luxon";
import { TZ, type ReleaseRule } from "./types.js";

export interface ReleasePolicy {
  releaseAt(targetDate: string): DateTime;
}

function parseHm(time: string): { hour: number; minute: number } {
  const m = /^(\d{2}):(\d{2})$/.exec(time);
  if (!m) throw new Error(`invalid time "${time}" (expected HH:mm)`);
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

function parseDate(date: string): DateTime {
  const d = DateTime.fromISO(date, { zone: TZ });
  if (!d.isValid || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`invalid date "${date}" (expected YYYY-MM-DD)`);
  return d.startOf("day");
}

export class DaysBeforeReleasePolicy implements ReleasePolicy {
  constructor(private readonly days: number, private readonly time: string) {}
  releaseAt(targetDate: string): DateTime {
    const { hour, minute } = parseHm(this.time);
    return parseDate(targetDate).minus({ days: this.days }).set({ hour, minute, second: 0, millisecond: 0 });
  }
}

/**
 * 「monthsAhead か月後の月末まで予約可」型。
 * 対象日を含む月が解禁されるのは、その月の monthsAhead か月前の月の openDay 日。
 * 例: monthsAhead=3, openDay=1 → 2027-01-20 は 2026-10-01 に解禁。
 */
export class MonthlyWindowReleasePolicy implements ReleasePolicy {
  constructor(private readonly monthsAhead: number, private readonly openDay: number, private readonly time: string) {}
  releaseAt(targetDate: string): DateTime {
    const { hour, minute } = parseHm(this.time);
    const target = parseDate(targetDate);
    return target
      .startOf("month")
      .minus({ months: this.monthsAhead })
      .set({ day: this.openDay, hour, minute, second: 0, millisecond: 0 });
  }
}

export class FixedReleasePolicy implements ReleasePolicy {
  constructor(private readonly at: string) {}
  releaseAt(): DateTime {
    const d = DateTime.fromISO(this.at, { zone: TZ });
    if (!d.isValid) throw new Error(`invalid fixed release "${this.at}"`);
    return d;
  }
}

export function policyFor(rule: ReleaseRule): ReleasePolicy {
  if (rule.timezone !== TZ) throw new Error(`timezone must be ${TZ}`);
  switch (rule.type) {
    case "days_before":
      return new DaysBeforeReleasePolicy(rule.days, rule.time);
    case "monthly_window":
      return new MonthlyWindowReleasePolicy(rule.monthsAhead, rule.openDay, rule.time);
    case "fixed":
      return new FixedReleasePolicy(rule.at);
  }
}
