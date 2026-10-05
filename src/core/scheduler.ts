/**
 * 常駐スケジューラ。cron 起動ではなく、常駐プロセスが解禁時刻に向けて段階的に準備する。
 *
 *   T-24h  preflight_24h : サイト到達・セッション・施設ページ・selector・対象日ページ
 *   T-10m  preflight_10m : セッション再確認（切れていれば1回だけ再ログイン）・時刻同期確認・ブラウザ起動
 *   T-15s  release       : 発火権を取得し、T=0 までミリ秒精度で待ってからエンジン実行
 *
 * フェーズの発火は DB の claimPhase で一意化しているため、再起動・二重起動でも重複しない。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DateTime } from "luxon";
import type { Logger } from "pino";
import type { Notifier } from "./notification.js";
import type { ReservationEngine } from "./reservation-engine.js";
import { TZ, type ProviderAdapter } from "./types.js";
import type { Phase, Store } from "../storage/db.js";

export const RELEASE_LEAD_MS = 15_000;
/** 解禁時刻を過ぎて起動した場合に、まだ実行する猶予 */
export const RELEASE_LATE_TOLERANCE_MS = 30 * 60_000;

export function planPhases(releaseAt: DateTime): { phase: Phase; dueAt: DateTime }[] {
  return [
    { phase: "preflight_24h", dueAt: releaseAt.minus({ hours: 24 }) },
    { phase: "preflight_10m", dueAt: releaseAt.minus({ minutes: 10 }) },
    { phase: "release", dueAt: releaseAt },
  ];
}

/** setTimeout で手前まで寝てから、最後の数十msだけ短い間隔で待つ */
export async function sleepUntil(target: DateTime, nowMs: () => number = Date.now): Promise<void> {
  const t = target.toMillis();
  for (;;) {
    const remain = t - nowMs();
    if (remain <= 0) return;
    await new Promise((r) => setTimeout(r, remain > 60 ? remain - 50 : 1));
  }
}

const execFileP = promisify(execFile);

/** chrony の推定オフセット（秒）。取得できなければ null */
export async function clockOffsetSeconds(): Promise<number | null> {
  try {
    const { stdout } = await execFileP("chronyc", ["tracking"], { timeout: 5000 });
    const m = /System time\s*:\s*([\d.]+) seconds (fast|slow)/.exec(stdout);
    if (!m) return null;
    return Number(m[1]) * (m[2] === "fast" ? 1 : -1);
  } catch {
    return null;
  }
}

export interface SchedulerDeps {
  store: Store;
  providers: Map<string, ProviderAdapter>;
  engineFor: (provider: ProviderAdapter) => ReservationEngine;
  notifier: Notifier;
  log: Logger;
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private busy = new Set<string>();

  constructor(private readonly d: SchedulerDeps) {}

  start(): void {
    this.d.log.info("scheduler started");
    this.timer = setInterval(() => void this.tick(), 1000);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(nowDt: DateTime = DateTime.now().setZone(TZ)): Promise<void> {
    for (const p of this.d.store.pendingPhases()) {
      if (p.fired_at) continue;
      const due = DateTime.fromISO(p.due_at, { zone: TZ });
      const lead = p.phase === "release" ? RELEASE_LEAD_MS : 0;
      if (nowDt.toMillis() < due.toMillis() - lead) continue;
      const key = `${p.request_id}:${p.phase}`;
      if (this.busy.has(key)) continue;
      if (!this.d.store.claimPhase(p.request_id, p.phase)) continue;
      this.busy.add(key);
      void this.execute(p.request_id, p.phase, due)
        .catch((e) => this.d.log.error({ err: (e as Error).message, key }, "phase failed"))
        .finally(() => this.busy.delete(key));
    }
  }

  private async execute(requestId: string, phase: Phase, due: DateTime): Promise<void> {
    const { store, providers, notifier, log } = this.d;
    const req = store.getRequest(requestId);
    if (!req) return;
    const provider = providers.get(req.provider);
    if (!provider) {
      await notifier.send("preflight_failed", `⚠️ provider "${req.provider}" が未登録です (${requestId})`);
      return;
    }
    const plog = log.child({ requestId, phase });

    if (phase === "release") {
      const lateMs = Date.now() - due.toMillis();
      if (lateMs > RELEASE_LATE_TOLERANCE_MS) {
        store.finishPhase(requestId, phase, `missed by ${Math.round(lateMs / 1000)}s`);
        store.transition(requestId, ["scheduled", "preflight_ok"], "manual_intervention_required");
        await notifier.send("manual_intervention", `⚠️ 解禁時刻を過ぎて起動したため自動実行しませんでした\n${req.targetDate} ${req.facility}`);
        return;
      }
      await sleepUntil(due);
      plog.info({ at: DateTime.now().setZone(TZ).toISO() }, "release fired");
      const outcome = await this.d.engineFor(provider).run(requestId);
      store.finishPhase(requestId, phase, outcome.kind);
      return;
    }

    const problems: string[] = [];
    let session = await provider.validateSession().catch((e) => ({ valid: false, detail: (e as Error).message }));
    if (!session.valid && phase === "preflight_10m") {
      // 本番直前は1回だけ再ログインを試みる。ループさせない（CSRF 403 の再発防止）
      await provider.authenticate().catch((e) => problems.push(`再ログイン失敗: ${(e as Error).message}`));
      session = await provider.validateSession().catch((e) => ({ valid: false, detail: (e as Error).message }));
    }
    store.setSession(provider.id, session.valid ? "valid" : "invalid", session.detail);
    if (!session.valid) problems.push(`セッション無効: ${session.detail}`);

    const pf = await provider.preflight(req).catch((e) => ({ ok: false, checks: [{ name: "preflight", ok: false, detail: (e as Error).message }] }));
    for (const c of pf.checks.filter((c) => !c.ok)) problems.push(`${c.name}: ${c.detail}`);

    if (phase === "preflight_10m") {
      const off = await clockOffsetSeconds();
      if (off === null) problems.push("時刻同期状態を取得できません（chronyc）");
      else if (Math.abs(off) > 0.5) problems.push(`時刻ずれ ${off.toFixed(3)}s`);
    }

    if (problems.length === 0) {
      store.transition(requestId, ["scheduled"], "preflight_ok");
      store.finishPhase(requestId, phase, "ok");
      plog.info("preflight ok");
      if (phase === "preflight_24h") {
        await notifier.send("info", `🟢 事前チェックOK（T-24h）\n${req.targetDate} ${req.facility}\n解禁 ${due.toFormat("yyyy/MM/dd HH:mm")}`);
      }
    } else {
      store.transition(requestId, ["preflight_ok"], "scheduled");
      store.finishPhase(requestId, phase, `ng: ${problems.join(" / ")}`);
      const kind = problems.some((p) => p.startsWith("セッション") || p.startsWith("再ログイン")) ? "session_expired" : "preflight_failed";
      await notifier.send(kind, `⚠️ 事前チェック失敗（${phase === "preflight_24h" ? "T-24h" : "T-10m"}）\n${req.targetDate} ${req.facility}\n${problems.join("\n")}`);
    }
  }
}

/** `next-jobs` 表示用 */
export function formatNextJobs(store: Store): string {
  const rows = store.pendingPhases();
  if (rows.length === 0) return "(予定なし)";
  return rows
    .map((p) => {
      const r = store.getRequest(p.request_id)!;
      const due = DateTime.fromISO(p.due_at, { zone: TZ }).toFormat("yyyy-MM-dd HH:mm:ss");
      const st = p.fired_at ? `済:${p.result ?? "実行中"}` : "未";
      return `${due}  ${p.phase.padEnd(14)} ${r.provider} / ${r.facility} / ${r.targetDate}  [${r.status}] [${st}]`;
    })
    .join("\n");
}
