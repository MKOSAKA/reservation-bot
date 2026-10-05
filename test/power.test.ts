import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { planWakeTimes, shouldPowerOff } from "../src/infra/power.js";
import { DaysBeforeReleasePolicy } from "../src/core/release-policy.js";
import { planPhases } from "../src/core/scheduler.js";
import { TZ } from "../src/core/types.js";

const at = (iso: string) => DateTime.fromISO(iso, { zone: TZ });

describe("wake planning", () => {
  it("wakes 60 min before T-24h and T0, plus a retry 30 min before T0", () => {
    const phases = planPhases(new DaysBeforeReleasePolicy(60, "00:00").releaseAt("2026-12-13"));
    const w = planWakeTimes("2026-12-13-morinomiya", phases, at("2026-10-05T12:00"));
    expect(w.map((x) => `${x.name}@${x.at.toFormat("MM-dd HH:mm")}`)).toEqual([
      "rb-2026-12-13-morinomiya-pf24@10-12 23:00",
      "rb-2026-12-13-morinomiya-rel@10-13 23:00",
      "rb-2026-12-13-morinomiya-rel-retry@10-13 23:30",
    ]);
  });

  it("skips wake times already in the past", () => {
    const phases = planPhases(new DaysBeforeReleasePolicy(60, "00:00").releaseAt("2026-12-13"));
    expect(planWakeTimes("x", phases, at("2026-10-13T12:00")).map((x) => x.name)).toEqual(["rb-x-rel", "rb-x-rel-retry"]);
  });
});

describe("idle power-off", () => {
  const base = { now: at("2026-10-13T01:00"), bootedAt: at("2026-10-12T23:00"), nextDue: at("2026-10-13T23:50"), running: false, keepalive: false };
  it("powers off when nothing is near", () => expect(shouldPowerOff(base)).toBe(true));
  it("stays up while a job runs", () => expect(shouldPowerOff({ ...base, running: true })).toBe(false));
  it("stays up with keepalive", () => expect(shouldPowerOff({ ...base, keepalive: true })).toBe(false));
  it("stays up shortly after boot", () => expect(shouldPowerOff({ ...base, bootedAt: at("2026-10-13T00:50") })).toBe(false));
  it("stays up when the next phase is within 75 min", () => expect(shouldPowerOff({ ...base, nextDue: at("2026-10-13T02:00") })).toBe(false));
});
