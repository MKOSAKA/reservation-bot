/** 予約リクエスト YAML の読み込みと検証。 */
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import { TZ, type ReservationRequest } from "../core/types.js";

const hm = z.string().regex(/^\d{2}:\d{2}$/, "HH:mm");

const releaseSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("days_before"), days: z.number().int().positive(), time: hm, timezone: z.literal(TZ) }),
  z.object({ type: z.literal("monthly_window"), months_ahead: z.number().int().positive(), open_day: z.number().int().min(1).max(28), time: hm, timezone: z.literal(TZ) }),
  z.object({ type: z.literal("fixed"), at: z.string(), timezone: z.literal(TZ) }),
]);

export const requestSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    provider: z.string(),
    facility: z.string(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    duration_minutes: z.number().int().positive(),
    // Provider によって呼び名が違うだけなので、いずれか1つを受け付ける
    space_priority: z.array(z.string()).optional(),
    court_priority: z.array(z.string()).optional(),
    room_priority: z.array(z.string()).optional(),
    time_priority: z.array(hm).min(1),
    time_first: z.boolean().default(true),
    people: z.number().int().min(1).max(99).optional(),
    earliest_start: hm.optional(),
    latest_end: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    max_price: z.number().int().positive().nullable().default(null),
    release: releaseSchema.optional(),
    mode: z.enum(["dry-run", "assist", "auto"]).default("dry-run"),
  })
  .refine((v) => [v.space_priority, v.court_priority, v.room_priority].filter(Boolean).length === 1, {
    message: "space_priority / court_priority / room_priority のいずれか1つを指定してください",
  });

export type RequestYaml = z.infer<typeof requestSchema>;

export function toRequest(y: RequestYaml): Omit<ReservationRequest, "release"> & { release: ReservationRequest["release"] | null } {
  const space = (y.space_priority ?? y.court_priority ?? y.room_priority)!;
  const r = y.release;
  return {
    id: y.id,
    provider: y.provider,
    facility: y.facility,
    targetDate: y.date,
    durationMinutes: y.duration_minutes,
    preferences: {
      spacePriority: space,
      timePriority: y.time_priority,
      timeFirst: y.time_first,
      ...(y.people !== undefined ? { people: y.people } : {}),
      ...(y.earliest_start ? { earliestStart: y.earliest_start } : {}),
      ...(y.latest_end ? { latestEnd: y.latest_end } : {}),
    },
    maxPrice: y.max_price,
    release: !r
      ? null
      : r.type === "days_before"
        ? { type: "days_before", days: r.days, time: r.time, timezone: TZ }
        : r.type === "monthly_window"
          ? { type: "monthly_window", monthsAhead: r.months_ahead, openDay: r.open_day, time: r.time, timezone: TZ }
          : { type: "fixed", at: r.at, timezone: TZ },
    mode: y.mode,
    status: "scheduled",
  };
}

export function loadRequestFile(path: string) {
  return toRequest(requestSchema.parse(parse(readFileSync(path, "utf8"))));
}
