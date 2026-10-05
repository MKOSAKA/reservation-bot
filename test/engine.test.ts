import { DateTime } from "luxon";
import pino from "pino";
import { beforeEach, describe, expect, it } from "vitest";
import type { Notifier, NotifyKind } from "../src/core/notification.js";
import { ReservationEngine } from "../src/core/reservation-engine.js";
import { DaysBeforeReleasePolicy } from "../src/core/release-policy.js";
import { resolveCandidateSlots } from "../src/core/slots.js";
import {
  ProviderError,
  TZ,
  type AvailabilitySnapshot,
  type Candidate,
  type ErrorCategory,
  type ProviderAdapter,
  type ReservationRequest,
  type ReservationResult,
  type Slot,
  type SlotState,
} from "../src/core/types.js";
import { Store } from "../src/storage/db.js";

const log = pino({ level: "silent" });

class RecordingNotifier implements Notifier {
  sent: { kind: NotifyKind; text: string }[] = [];
  async send(kind: NotifyKind, text: string) {
    this.sent.push({ kind, text });
  }
}

/** 日曜 9:30〜20:30 の1時間枠。states で状態を上書き */
function snapshot(states: Record<string, SlotState> = {}, def: SlotState = "available"): AvailabilitySnapshot {
  const slots: Slot[] = [];
  for (let h = 9; h <= 19; h++) {
    const start = DateTime.fromISO(`2026-12-13T${String(h).padStart(2, "0")}:30`, { zone: TZ });
    const hm = start.toFormat("HH:mm");
    slots.push({ spaceKey: "covered", start, end: start.plus({ hours: 1 }), state: states[hm] ?? def, ref: `/slot/${hm}` });
  }
  return { fetchedAt: DateTime.now().setZone(TZ), slots };
}

type ReserveBehavior = (c: Candidate) => ReservationResult | ProviderError;

class FakeProvider implements ProviderAdapter {
  readonly id = "fake";
  reserveCalls: string[] = [];
  availabilityCalls = 0;
  snapshots: (AvailabilitySnapshot | ProviderError)[] = [snapshot()];
  existing: ReservationResult | null = null;
  behavior: ReserveBehavior = (c) => ok(c);
  authCalls = 0;

  defaultReleaseRule() {
    return null;
  }
  async authenticate() {
    this.authCalls++;
  }
  async validateSession() {
    return { valid: true, detail: "" };
  }
  async getAvailability() {
    const s = this.snapshots[Math.min(this.availabilityCalls++, this.snapshots.length - 1)]!;
    if (s instanceof ProviderError) throw s;
    return s;
  }
  async reserve(_r: ReservationRequest, c: Candidate) {
    this.reserveCalls.push(c.start.toFormat("HH:mm"));
    const r = this.behavior(c);
    if (r instanceof ProviderError) throw r;
    return r;
  }
  async findExistingReservation() {
    return this.existing;
  }
  async preflight() {
    return { ok: true, checks: [] };
  }
  async captureEvidence(label: string) {
    return { label, screenshotPath: null, url: null, capturedAt: DateTime.now() };
  }
  estimatePrice(_r: ReservationRequest, c: Candidate) {
    return (c.end.diff(c.start, "hours").hours || 0) * 11000;
  }
  slotsForCandidate(s: AvailabilitySnapshot, c: Candidate) {
    return resolveCandidateSlots(s.slots, c);
  }
  async close() {}
}

function ok(c: Candidate): ReservationResult {
  return { externalReservationId: "R-1", spaceKey: c.spaceKey, start: c.start, end: c.end, price: 22000, finalUrl: "https://example/done" };
}
const err = (cat: ErrorCategory, submitted = false) => new ProviderError(cat, cat, submitted);

const baseReq: ReservationRequest = {
  id: "req-1",
  provider: "fake",
  facility: "morinomiya",
  targetDate: "2026-12-13",
  durationMinutes: 120,
  preferences: { spacePriority: ["covered"], timePriority: ["13:30", "12:30", "11:30", "14:30"], timeFirst: true },
  maxPrice: 22000,
  release: { type: "days_before", days: 60, time: "00:00", timezone: TZ },
  mode: "auto",
  status: "scheduled",
};

let store: Store;
let provider: FakeProvider;
let notifier: RecordingNotifier;
let sleeps: number[];
let engine: ReservationEngine;

beforeEach(() => {
  store = new Store(":memory:");
  store.upsertRequest(baseReq, new DaysBeforeReleasePolicy(60, "00:00").releaseAt(baseReq.targetDate));
  provider = new FakeProvider();
  notifier = new RecordingNotifier();
  sleeps = [];
  engine = new ReservationEngine({ store, provider, notifier, log, sleep: async (ms) => void sleeps.push(ms) });
});

describe("candidate fallback", () => {
  it("skips booked, falls back on SLOT_TAKEN, stops after first success", async () => {
    provider.snapshots = [snapshot({ "14:30": "booked" })]; // 14:30枠が埋まり → 第1候補(13:30-15:30)・第4候補(14:30-16:30)は不可
    provider.behavior = (c) => (c.start.toFormat("HH:mm") === "12:30" ? err("SLOT_TAKEN") : ok(c));
    const out = await engine.run("req-1");
    expect(out.kind).toBe("completed");
    expect(provider.reserveCalls).toEqual(["12:30", "11:30"]); // 14:30 は試さない
    expect(store.getRequest("req-1")!.status).toBe("completed");
    expect(store.reservationFor("req-1")).not.toBeNull();
    expect(notifier.sent.at(-1)!.text).toContain("✅ 予約成功");
  });

  it("reports failure when every candidate is unavailable", async () => {
    provider.snapshots = [snapshot({}, "booked")];
    const out = await engine.run("req-1");
    expect(out.kind).toBe("failed");
    expect(provider.reserveCalls).toEqual([]);
    expect(store.getRequest("req-1")!.status).toBe("failed");
    expect(notifier.sent.at(-1)!.text).toContain("すべて予約済み");
  });

  it("skips candidates above max_price", async () => {
    store.upsertRequest({ ...baseReq, maxPrice: 20000 }, DateTime.now());
    const out = await engine.run("req-1");
    expect(out.kind).toBe("failed");
    expect(store.attempts("req-1").filter((a) => a.error_category === "PRICE_EXCEEDED")).toHaveLength(4);
  });
});

describe("idempotency / double booking prevention", () => {
  it("does nothing on a second run after success", async () => {
    await engine.run("req-1");
    const out = await engine.run("req-1");
    expect(out.kind).toBe("already_done");
    expect(provider.reserveCalls).toHaveLength(1);
  });

  it("only one of two concurrent runs proceeds", async () => {
    const [a, b] = await Promise.all([engine.run("req-1"), engine.run("req-1")]);
    expect([a.kind, b.kind].sort()).toEqual(["completed", "locked"]);
    expect(provider.reserveCalls).toHaveLength(1);
  });

  it("records an existing reservation found on the site instead of booking again", async () => {
    provider.existing = ok({ rank: 1, spaceKey: "covered", start: DateTime.fromISO("2026-12-13T13:30", { zone: TZ }), end: DateTime.fromISO("2026-12-13T15:30", { zone: TZ }), label: "" });
    const out = await engine.run("req-1");
    expect(out.kind).toBe("already_done");
    expect(provider.reserveCalls).toEqual([]);
    expect(store.getRequest("req-1")!.status).toBe("completed");
  });

  it("stops (no further candidates) when the result after submit is uncertain", async () => {
    provider.behavior = () => err("NETWORK", true);
    const out = await engine.run("req-1");
    expect(out.kind).toBe("manual");
    expect(provider.reserveCalls).toEqual(["13:30"]);
    expect(store.getRequest("req-1")!.status).toBe("manual_intervention_required");
  });
});

describe("failure categories", () => {
  it("SITE_CHANGED on availability is not treated as 'no availability'", async () => {
    provider.snapshots = [err("SITE_CHANGED")];
    const out = await engine.run("req-1");
    expect(out.kind).toBe("manual");
    expect(store.getRequest("req-1")!.status).toBe("manual_intervention_required");
    expect(notifier.sent.at(-1)!.text).toContain("SITE_CHANGED");
  });

  it("does not retry 403 / CAPTCHA / 429", async () => {
    for (const cat of ["FORBIDDEN", "CAPTCHA", "RATE_LIMITED"] as const) {
      store = new Store(":memory:");
      store.upsertRequest(baseReq, DateTime.now());
      provider = new FakeProvider();
      provider.behavior = () => err(cat);
      engine = new ReservationEngine({ store, provider, notifier, log, sleep: async () => {} });
      const out = await engine.run("req-1");
      expect(out.kind).toBe("manual");
      expect(provider.reserveCalls).toHaveLength(1);
    }
  });

  it("retries transient 5xx a few times before submit", async () => {
    let n = 0;
    provider.behavior = (c) => (n++ < 2 ? err("SERVER_ERROR") : ok(c));
    const out = await engine.run("req-1");
    expect(out.kind).toBe("completed");
    expect(sleeps).toEqual([1000, 2000]);
  });

  it("re-authenticates once on SESSION_EXPIRED", async () => {
    let n = 0;
    provider.behavior = (c) => (n++ === 0 ? err("SESSION_EXPIRED") : ok(c));
    const out = await engine.run("req-1");
    expect(out.kind).toBe("completed");
    expect(provider.authCalls).toBe(1);
  });
});

describe("release polling", () => {
  it("polls with a small, increasing backoff until slots are released", async () => {
    provider.snapshots = [snapshot({}, "not_released"), snapshot({}, "not_released"), snapshot()];
    const out = await engine.run("req-1");
    expect(out.kind).toBe("completed");
    expect(sleeps).toEqual([1000, 2000]);
    expect(provider.availabilityCalls).toBe(3);
  });

  it("gives up after the bounded number of polls", async () => {
    provider.snapshots = [snapshot({}, "not_released")];
    const out = await engine.run("req-1");
    expect(out.kind).toBe("failed");
    expect(provider.availabilityCalls).toBe(6);
  });
});

describe("modes", () => {
  it("dry-run never reserves and never changes status", async () => {
    const out = await engine.run("req-1", "dry-run");
    expect(out).toMatchObject({ kind: "dry_run" });
    expect(provider.reserveCalls).toEqual([]);
    expect(store.getRequest("req-1")!.status).toBe("scheduled");
  });

  it("assist stops at the confirmation step without completing", async () => {
    provider.behavior = () => err("MODE_STOP");
    const out = await engine.run("req-1", "assist");
    expect(out.kind).toBe("assist_stopped");
    expect(store.getRequest("req-1")!.status).toBe("scheduled");
    expect(store.reservationFor("req-1")).toBeNull();
  });
});

describe("phase claiming", () => {
  it("a phase can be claimed only once (restart / duplicate daemon safe)", () => {
    store.ensurePhases("req-1", [{ phase: "release", dueAt: DateTime.now() }]);
    expect(store.claimPhase("req-1", "release")).toBe(true);
    expect(store.claimPhase("req-1", "release")).toBe(false);
  });
});

describe("release timing", () => {
  it("checks existing reservations before waiting for T0, then fetches availability", async () => {
    const order: string[] = [];
    const origFind = provider.findExistingReservation.bind(provider);
    provider.findExistingReservation = async () => (order.push("existing"), origFind());
    const origAvail = provider.getAvailability.bind(provider);
    provider.getAvailability = async () => (order.push("availability"), origAvail());
    await engine.run("req-1", undefined, async () => void order.push("wait-T0"));
    expect(order.slice(0, 3)).toEqual(["existing", "wait-T0", "availability"]);
  });
});

describe("cancel", () => {
  it("only scheduled-like requests can be cancelled, and cancelled ones are not executed", async () => {
    expect(store.transition("req-1", ["draft", "scheduled", "preflight_ok", "failed", "manual_intervention_required"], "cancelled")).toBe(true);
    const out = await engine.run("req-1");
    expect(out.kind).toBe("already_done");
    expect(provider.reserveCalls).toEqual([]);
    expect(store.pendingPhases()).toEqual([]);
  });
});
