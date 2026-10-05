import { describe, expect, it } from "vitest";
import { DaysBeforeReleasePolicy, MonthlyWindowReleasePolicy, policyFor } from "../src/core/release-policy.js";
import { planPhases } from "../src/core/scheduler.js";

describe("release policies (Asia/Tokyo)", () => {
  it("60 days before 2026-12-13 is 2026-10-14 00:00 JST (= 10-13 15:00 UTC)", () => {
    const at = new DaysBeforeReleasePolicy(60, "00:00").releaseAt("2026-12-13");
    expect(at.toISO()).toBe("2026-10-14T00:00:00.000+09:00");
    expect(at.toUTC().toISO()).toBe("2026-10-13T15:00:00.000Z");
  });

  it("matches the 2026-10-05 observation (12/04 open, 12/05 not yet)", () => {
    const p = new DaysBeforeReleasePolicy(60, "00:00");
    expect(p.releaseAt("2026-12-04").toISODate()).toBe("2026-10-05");
    expect(p.releaseAt("2026-12-05").toISODate()).toBe("2026-10-06");
  });

  it("monthly window: '3 months ahead to month end' opens on the 1st", () => {
    const p = new MonthlyWindowReleasePolicy(3, 1, "00:00");
    expect(p.releaseAt("2027-01-20").toISO()).toBe("2026-10-01T00:00:00.000+09:00");
    expect(p.releaseAt("2027-01-31").toISODate()).toBe("2026-10-01");
  });

  it("rejects non-JST timezone and bad input", () => {
    expect(() => policyFor({ type: "days_before", days: 1, time: "00:00", timezone: "UTC" as never })).toThrow();
    expect(() => new DaysBeforeReleasePolicy(60, "0:00").releaseAt("2026-12-13")).toThrow();
    expect(() => new DaysBeforeReleasePolicy(60, "00:00").releaseAt("2026/12/13")).toThrow();
  });

  it("plans T-24h, T-10m and T0 phases", () => {
    const at = new DaysBeforeReleasePolicy(60, "00:00").releaseAt("2026-12-13");
    expect(planPhases(at).map((p) => `${p.phase}@${p.dueAt.toFormat("MM-dd HH:mm")}`)).toEqual([
      "preflight_24h@10-13 00:00",
      "preflight_10m@10-13 23:50",
      "release@10-14 00:00",
    ]);
  });
});
