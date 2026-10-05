/** 希望条件を優先順位付きの候補列へ展開する。 */
import { DateTime } from "luxon";
import { TZ, type Candidate, type ReservationRequest } from "./types.js";

export function expandCandidates(req: ReservationRequest): Candidate[] {
  const { spacePriority, timePriority, timeFirst } = req.preferences;
  const pairs: [string, string][] = [];
  if (timeFirst) {
    for (const t of timePriority) for (const s of spacePriority) pairs.push([s, t]);
  } else {
    for (const s of spacePriority) for (const t of timePriority) pairs.push([s, t]);
  }
  return pairs.map(([spaceKey, time], i) => {
    const start = DateTime.fromISO(`${req.targetDate}T${time}`, { zone: TZ });
    if (!start.isValid) throw new Error(`invalid candidate time ${req.targetDate} ${time}`);
    const end = start.plus({ minutes: req.durationMinutes });
    return {
      rank: i + 1,
      spaceKey,
      start,
      end,
      label: `${spaceKey} ${start.toFormat("HH:mm")}-${end.toFormat("HH:mm")}`,
    };
  });
}

/** 開始の下限・終了の上限で候補を絞る（rank は振り直す） */
export function applyWindow(req: ReservationRequest, candidates: Candidate[]): Candidate[] {
  const { earliestStart, latestEnd } = req.preferences;
  const kept = candidates.filter((c) => {
    if (earliestStart && c.start.toFormat("HH:mm") < earliestStart) return false;
    if (latestEnd) {
      const endHm = c.end.hasSame(c.start, "day") ? c.end.toFormat("HH:mm") : "24:00";
      if (endHm > latestEnd) return false;
    }
    return true;
  });
  return kept.map((c, i) => ({ ...c, rank: i + 1 }));
}
