/**
 * 予約リクエストの解決と検証（DB・秘密情報・ブラウザを使わない）。
 * CI（PR時）と GitHub Actions の登録前チェック、サーバ上の `add` で共通に使う。
 */
import { basename } from "node:path";
import { DateTime } from "luxon";
import { loadRequestFile } from "./load.js";
import { policyFor } from "../core/release-policy.js";
import { TZ, type ReservationRequest } from "../core/types.js";
import { LABOLA_FACILITIES } from "../providers/labola/facilities.js";
import { STUDIOL_FACILITIES } from "../providers/studiol/facilities.js";

interface ProviderCatalog {
  facilities: () => string[];
  spaces: (facility: string) => string[] | null;
  defaultRelease: (facility: string) => ReservationRequest["release"] | null;
}

/** 実装済み Provider の静的カタログ。新しい Provider を足したらここにも登録する */
export const CATALOG: Record<string, ProviderCatalog> = {
  labola: {
    facilities: () => Object.keys(LABOLA_FACILITIES),
    spaces: (f) => (LABOLA_FACILITIES[f] ? Object.keys(LABOLA_FACILITIES[f]!.spaces) : null),
    defaultRelease: (f) => LABOLA_FACILITIES[f]?.release ?? null,
  },
  studiol: {
    facilities: () => Object.keys(STUDIOL_FACILITIES),
    spaces: (f) => (STUDIOL_FACILITIES[f] ? Object.keys(STUDIOL_FACILITIES[f]!.rooms) : null),
    defaultRelease: (f) => STUDIOL_FACILITIES[f]?.release ?? null,
  },
};

export interface Resolved {
  req: ReservationRequest;
  releaseAt: DateTime;
  warnings: string[];
}

export function resolveRequestFile(path: string, now: DateTime = DateTime.now().setZone(TZ)): Resolved {
  const r = loadRequestFile(path);
  if (basename(path, ".yaml") !== r.id) throw new Error(`ファイル名と id が一致しません（${basename(path)} / id: ${r.id}）`);
  const cat = CATALOG[r.provider];
  if (!cat) throw new Error(`未対応の provider "${r.provider}"（対応: ${Object.keys(CATALOG).join(", ")}）`);
  const spaces = cat.spaces(r.facility);
  if (!spaces) throw new Error(`未登録の facility "${r.facility}"（${r.provider}: ${cat.facilities().join(", ")}）`);
  const unknown = r.preferences.spacePriority.filter((s) => !spaces.includes(s));
  if (unknown.length) throw new Error(`未登録のコート/部屋 ${unknown.join(", ")}（${r.facility}: ${spaces.join(", ")}）`);

  const release = r.release ?? cat.defaultRelease(r.facility);
  if (!release) throw new Error("release が未指定で、施設の既定値もありません");
  const req: ReservationRequest = { ...r, release };
  const releaseAt = policyFor(release).releaseAt(req.targetDate);

  const warnings: string[] = [];
  const target = DateTime.fromISO(req.targetDate, { zone: TZ });
  if (target < now.startOf("day")) throw new Error(`利用日 ${req.targetDate} は過去です`);
  if (releaseAt < now) warnings.push(`解禁日時 ${releaseAt.toFormat("yyyy-MM-dd HH:mm")} は過去です（既に解禁済み。空きがあれば即時に試行）`);
  else if (releaseAt.diff(now, "hours").hours < 24) warnings.push(`解禁まで24時間未満のため、T-24h チェックは即時に実行されます`);
  if (releaseAt.diff(now, "minutes").minutes < 70 && releaseAt > now) warnings.push("解禁まで70分未満。起動が間に合わない可能性があります");
  if (req.mode !== "auto") warnings.push(`mode=${req.mode}（確定まで行わない）`);
  return { req, releaseAt, warnings };
}

export function describeResolved(x: Resolved): string {
  const p = x.req.preferences;
  return [
    `${x.req.id}: ${x.req.provider}/${x.req.facility} ${x.req.targetDate} ${x.req.durationMinutes}分`,
    `  候補: ${p.spacePriority.join(">")} × ${p.timePriority.join(">")}  上限: ${x.req.maxPrice ?? "なし"}円  mode: ${x.req.mode}`,
    `  解禁: ${x.releaseAt.toFormat("yyyy-MM-dd HH:mm:ss")} JST`,
    ...x.warnings.map((w) => `  ⚠ ${w}`),
  ].join("\n");
}
