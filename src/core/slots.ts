/** 候補（開始〜終了）を構成する枠の解決。Provider共通で使える汎用ロジック。 */
import type { Candidate, Slot } from "./types.js";

/**
 * - 候補と重なる枠が1つも無い → null（設定ミスかサイト構造の変化）
 * - 重なる枠に予約不可が含まれる → その枠を含めて返す（呼び出し側が理由を判断する）
 * - すべて available で、境界が一致し連続している → その枠列
 * - available だが境界がずれる（例: 13:00開始なのに枠が :30 区切り） → null
 */
export function resolveCandidateSlots(slots: Slot[], c: Candidate): Slot[] | null {
  const s0 = c.start.toMillis();
  const e0 = c.end.toMillis();
  const overlapping = slots
    .filter((s) => s.spaceKey === c.spaceKey && s.start.toMillis() < e0 && s.end.toMillis() > s0)
    .sort((a, b) => a.start.toMillis() - b.start.toMillis());
  if (overlapping.length === 0) return null;
  if (overlapping.some((s) => s.state !== "available")) return overlapping;
  if (overlapping[0]!.start.toMillis() !== s0 || overlapping[overlapping.length - 1]!.end.toMillis() !== e0) return null;
  for (let i = 1; i < overlapping.length; i++) {
    if (overlapping[i]!.start.toMillis() !== overlapping[i - 1]!.end.toMillis()) return null;
  }
  return overlapping;
}
