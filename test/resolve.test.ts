import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { resolveRequestFile } from "../src/config/resolve.js";
import { TZ } from "../src/core/types.js";

const fx = (n: string) => new URL(`./fixtures/requests/${n}`, import.meta.url).pathname;

describe("request validation", () => {
  it("applies the facility default release rule (60 days before, 00:00)", () => {
    const r = resolveRequestFile(fx("ok.yaml"), DateTime.fromISO("2099-01-01", { zone: TZ }));
    expect(r.releaseAt.toISO()).toBe("2099-10-14T00:00:00.000+09:00");
    expect(r.warnings).toEqual([]);
  });
  it("rejects unknown courts with the list of valid keys", () => {
    expect(() => resolveRequestFile(fx("bad-space.yaml"))).toThrow(/roofed.*covered, open/);
  });
  it("warns when the release is already past", () => {
    const r = resolveRequestFile(fx("ok.yaml"), DateTime.fromISO("2099-11-01", { zone: TZ }));
    expect(r.warnings.join()).toMatch(/過去/);
  });
});
