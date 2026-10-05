/**
 * 予約エンジン。候補を優先順に試し、1件成功したら即停止する。
 *
 * 二重予約を防ぐ規則:
 *  - auto 実行は `scheduled|preflight_ok → running` の条件付き遷移に成功した1プロセスだけが進む
 *  - DB に予約が記録済み、またはサイト上に既存予約があれば何もしない
 *  - 確定ボタン送信後に結果が確認できない（submitted=true の失敗）場合は、他候補へ進まず人手確認へ回す
 */
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { expandCandidates } from "./candidates.js";
import type { Notifier } from "./notification.js";
import {
  ProviderError,
  type AvailabilitySnapshot,
  type Candidate,
  type ErrorCategory,
  type Mode,
  type ProviderAdapter,
  type ReservationRequest,
  type ReservationResult,
} from "./types.js";
import type { Store } from "../storage/db.js";

export interface EngineDeps {
  store: Store;
  provider: ProviderAdapter;
  notifier: Notifier;
  log: Logger;
  sleep?: (ms: number) => Promise<void>;
}

/** 解禁直後の再取得間隔（ms）。サイト負荷を避けるため少数・漸増に限る */
export const RELEASE_POLL_BACKOFF = [1000, 2000, 3000, 5000, 10000];
/** 送信前の一時的エラー（5xx・ネットワーク）の再試行間隔 */
export const TRANSIENT_RETRY_BACKOFF = [1000, 2000];

const STOP_CATEGORIES: ErrorCategory[] = ["CAPTCHA", "AUTH_CHALLENGE", "FORBIDDEN", "RATE_LIMITED", "SITE_CHANGED", "UNCERTAIN_SUBMISSION", "UNKNOWN"];
const TRANSIENT: ErrorCategory[] = ["SERVER_ERROR", "NETWORK"];

export type RunOutcome =
  | { kind: "completed"; result: ReservationResult }
  | { kind: "already_done" }
  | { kind: "locked" }
  | { kind: "dry_run"; viable: Candidate | null }
  | { kind: "assist_stopped"; candidate: Candidate }
  | { kind: "failed"; reason: string }
  | { kind: "manual"; reason: string };

function toProviderError(e: unknown): ProviderError {
  if (e instanceof ProviderError) return e;
  const msg = (e as Error)?.message ?? String(e);
  if (/net::|ECONN|ETIMEDOUT|ENOTFOUND|Timeout/i.test(msg)) return new ProviderError("NETWORK", msg);
  return new ProviderError("UNKNOWN", msg);
}

export class ReservationEngine {
  private readonly sleep: (ms: number) => Promise<void>;
  constructor(private readonly d: EngineDeps) {
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async run(requestId: string, modeOverride?: Mode): Promise<RunOutcome> {
    const { store, provider, notifier, log } = this.d;
    const stored = store.getRequest(requestId);
    if (!stored) throw new Error(`request ${requestId} not found`);
    const req: ReservationRequest = { ...stored, mode: modeOverride ?? stored.mode };
    const runToken = randomUUID();
    const rlog = log.child({ requestId, runToken, mode: req.mode });

    if (store.reservationFor(req.id)) {
      store.transition(req.id, ["scheduled", "preflight_ok", "running", "failed"], "completed");
      rlog.info("already reserved in DB; skip");
      return { kind: "already_done" };
    }
    if (stored.status === "completed" || stored.status === "cancelled") return { kind: "already_done" };

    if (req.mode === "auto") {
      if (!store.transition(req.id, ["scheduled", "preflight_ok"], "running", runToken)) {
        rlog.warn({ status: store.getRequest(req.id)?.status }, "could not acquire run lock");
        return { kind: "locked" };
      }
      const existing = await this.safe(() => provider.findExistingReservation(req));
      if (existing instanceof ProviderError) {
        return this.manual(req, runToken, `既存予約の照合に失敗: ${existing.category} ${existing.message}`);
      }
      if (existing) {
        store.recordReservation(req, existing);
        store.transition(req.id, ["running"], "completed");
        await notifier.send("info", `ℹ️ 既存予約を検出したため新規予約はしませんでした\n${this.describe(req, existing)}`);
        return { kind: "already_done" };
      }
    }

    // 1) 解禁を待ちつつ空きを取得
    const snapOrErr = await this.fetchReleasedSnapshot(req, runToken);
    if (snapOrErr instanceof ProviderError) {
      if (req.mode === "auto") return this.manual(req, runToken, `空き取得に失敗: ${snapOrErr.category} ${snapOrErr.message}`);
      return { kind: "failed", reason: snapOrErr.message };
    }
    const snapshot = snapOrErr;

    // 2) 候補を順に試行
    const candidates = expandCandidates(req);
    const reasons: string[] = [];
    let reauthed = false;
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i]!;
      const slots = provider.slotsForCandidate(snapshot, c);
      if (!slots) {
        store.recordAttempt(req.id, runToken, c, "skipped", "NO_AVAILABILITY", "該当する枠がカレンダー上に存在しない（設定の時刻・コートを確認）");
        reasons.push(`${c.label}: 枠なし`);
        continue;
      }
      const notAvail = slots.find((s) => s.state !== "available");
      if (notAvail) {
        const cat: ErrorCategory = notAvail.state === "not_released" ? "NOT_RELEASED" : "NO_AVAILABILITY";
        store.recordAttempt(req.id, runToken, c, "skipped", cat, `slot ${notAvail.start.toFormat("HH:mm")} is ${notAvail.state}`);
        reasons.push(`${c.label}: ${notAvail.state}`);
        continue;
      }
      const price = provider.estimatePrice(req, c);
      if (req.maxPrice !== null && price !== null && price > req.maxPrice) {
        store.recordAttempt(req.id, runToken, c, "skipped", "PRICE_EXCEEDED", `price ${price} > max ${req.maxPrice}`);
        reasons.push(`${c.label}: 料金超過`);
        continue;
      }
      if (req.mode === "dry-run") {
        store.recordAttempt(req.id, runToken, c, "viable", null, `dry-run: 予約可能（推定料金 ${price ?? "不明"}）`);
        rlog.info({ candidate: c.label }, "dry-run viable candidate");
        return { kind: "dry_run", viable: c };
      }

      // 予約実行（送信前の一時的エラーのみ少数回再試行）
      let attempt = 0;
      for (;;) {
        try {
          const result = await provider.reserve(req, c, snapshot, req.mode);
          store.recordAttempt(req.id, runToken, c, "success", null, `reservation ${result.externalReservationId ?? "(番号不明)"}`);
          await this.evidence("success");
          if (req.mode === "auto") {
            store.recordReservation(req, result);
            store.transition(req.id, ["running"], "completed");
          }
          await notifier.send("success", `✅ 予約成功\n\n${this.describe(req, result)}`);
          return { kind: "completed", result };
        } catch (e) {
          const pe = toProviderError(e);
          store.recordAttempt(req.id, runToken, c, "error", pe.category, pe.message);
          rlog.warn({ candidate: c.label, category: pe.category, submitted: pe.submitted }, pe.message);

          if (pe.category === "MODE_STOP") {
            await this.evidence("assist-stop");
            await notifier.send("info", `🟡 assist: 確認画面で停止しました\n${req.facility} ${c.label}`);
            return { kind: "assist_stopped", candidate: c };
          }
          if (pe.submitted || pe.category === "UNCERTAIN_SUBMISSION") {
            await this.evidence("uncertain");
            return this.manual(req, runToken, `予約送信後に結果を確認できませんでした（${c.label}）。二重予約を避けるため停止します。サイトのマイページで確認してください。`);
          }
          if (pe.category === "SESSION_EXPIRED" && !reauthed) {
            reauthed = true;
            const r = await this.safe(() => provider.authenticate());
            if (r instanceof ProviderError) return this.manual(req, runToken, `再ログインに失敗: ${r.category} ${r.message}`, "session_expired");
            continue;
          }
          if (TRANSIENT.includes(pe.category) && attempt < TRANSIENT_RETRY_BACKOFF.length) {
            await this.sleep(TRANSIENT_RETRY_BACKOFF[attempt++]!);
            continue;
          }
          if (pe.category === "SLOT_TAKEN" || pe.category === "NO_AVAILABILITY" || pe.category === "PRICE_EXCEEDED") {
            reasons.push(`${c.label}: ${pe.category === "SLOT_TAKEN" ? "先に予約された" : pe.category}`);
            break; // 次候補へ
          }
          await this.evidence("stop");
          const kind = pe.category === "SITE_CHANGED" ? "site_changed" : pe.category === "SESSION_EXPIRED" ? "session_expired" : "manual_intervention";
          return this.manual(req, runToken, `${pe.category}: ${pe.message}`, kind);
        }
      }
    }

    // 3) 全候補失敗
    if (req.mode === "dry-run") return { kind: "dry_run", viable: null };
    if (req.mode === "auto") store.transition(req.id, ["running"], "failed");
    await this.evidence("failure");
    const allTaken = reasons.every((r) => /booked|先に予約|blocked/.test(r));
    await this.d.notifier.send(
      "failure",
      `❌ 予約失敗\n\n${req.targetDate} ${req.facility}\n\n候補${candidates.length}件を試行しましたが、予約できませんでした。\n\n理由：\n${allTaken ? "すべて予約済み" : reasons.join("\n")}`,
    );
    return { kind: "failed", reason: reasons.join("; ") };
  }

  private async fetchReleasedSnapshot(req: ReservationRequest, runToken: string): Promise<AvailabilitySnapshot | ProviderError> {
    const { provider, store } = this.d;
    const candidates = expandCandidates(req);
    let transient = 0;
    for (let poll = 0; ; ) {
      let snap: AvailabilitySnapshot;
      try {
        snap = await provider.getAvailability(req);
      } catch (e) {
        const pe = toProviderError(e);
        store.recordAttempt(req.id, runToken, null, "availability_error", pe.category, pe.message);
        if (TRANSIENT.includes(pe.category) && transient < TRANSIENT_RETRY_BACKOFF.length) {
          await this.sleep(TRANSIENT_RETRY_BACKOFF[transient++]!);
          continue;
        }
        return pe;
      }
      const relevant = candidates.flatMap((c) => provider.slotsForCandidate(snap, c) ?? []);
      const released = relevant.length > 0 && relevant.some((s) => s.state !== "not_released");
      if (released || poll >= RELEASE_POLL_BACKOFF.length) return snap;
      store.recordAttempt(req.id, runToken, null, "waiting_release", "NOT_RELEASED", `poll ${poll + 1}`);
      await this.sleep(RELEASE_POLL_BACKOFF[poll++]!);
    }
  }

  private async manual(req: ReservationRequest, runToken: string, reason: string, kind: Parameters<Notifier["send"]>[0] = "manual_intervention"): Promise<RunOutcome> {
    this.d.store.recordAttempt(req.id, runToken, null, "stopped", null, reason);
    if (req.mode === "auto") this.d.store.transition(req.id, ["running", "scheduled", "preflight_ok"], "manual_intervention_required");
    await this.d.notifier.send(kind, `⚠️ 要対応\n\n${req.targetDate} ${req.facility}\n${reason}`);
    return { kind: "manual", reason };
  }

  private async safe<T>(fn: () => Promise<T>): Promise<T | ProviderError> {
    try {
      return await fn();
    } catch (e) {
      return toProviderError(e);
    }
  }

  private async evidence(label: string): Promise<void> {
    try {
      await this.d.provider.captureEvidence(label);
    } catch (e) {
      this.d.log.warn({ err: (e as Error).message }, "evidence capture failed");
    }
  }

  private describe(req: ReservationRequest, r: ReservationResult): string {
    return [
      `施設：\n${req.facility}`,
      `日時：\n${r.start.toFormat("yyyy/MM/dd HH:mm")}〜${r.end.toFormat("HH:mm")}`,
      `コート：\n${r.spaceKey}`,
      `料金：\n${r.price !== null ? `${r.price.toLocaleString("ja-JP")}円` : "不明"}`,
      `予約番号：\n${r.externalReservationId ?? "不明（マイページで確認）"}`,
    ].join("\n\n");
  }
}
