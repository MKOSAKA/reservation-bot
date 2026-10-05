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
