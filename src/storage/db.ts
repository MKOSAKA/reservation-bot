/**
 * SQLite 永続化。二重予約防止の要は次の3点。
 *  1. 状態遷移は「期待する現在状態」を WHERE に含めた UPDATE で行い、changes=0 なら他者が先行したとみなす
 *  2. reservations(request_id) に UNIQUE 制約。同一リクエストで予約は1件しか記録できない
 *  3. job_phases の fired_at を条件付き UPDATE で立てる。再起動・二重起動でも同じフェーズは1回しか実行されない
 * プロセス二重起動そのものは、daemon 側で排他ロックファイルを取って防ぐ（cli.ts）。
 */
import Database from "better-sqlite3";
import { DateTime } from "luxon";
import { TZ, type Candidate, type ErrorCategory, type ReservationRequest, type ReservationResult, type RequestStatus } from "../core/types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS reservation_requests (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  facility TEXT NOT NULL,
  target_date TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL,
  preferences_json TEXT NOT NULL,
  max_price INTEGER,
  release_json TEXT NOT NULL,
  release_at TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  run_token TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reservation_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL REFERENCES reservation_requests(id),
  run_token TEXT NOT NULL,
  attempted_at TEXT NOT NULL,
  candidate TEXT NOT NULL,
  result TEXT NOT NULL,
  error_category TEXT,
  detail TEXT
);
CREATE TABLE IF NOT EXISTS reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL UNIQUE REFERENCES reservation_requests(id),
  provider TEXT NOT NULL,
  external_reservation_id TEXT,
  facility TEXT NOT NULL,
  space_key TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  price INTEGER,
  status TEXT NOT NULL,
  final_url TEXT
);
CREATE TABLE IF NOT EXISTS session_status (
  provider TEXT PRIMARY KEY,
  last_validated_at TEXT,
  expires_at TEXT,
  state TEXT NOT NULL,
  detail TEXT
);
CREATE TABLE IF NOT EXISTS job_phases (
  request_id TEXT NOT NULL REFERENCES reservation_requests(id),
  phase TEXT NOT NULL,
  due_at TEXT NOT NULL,
  fired_at TEXT,
  result TEXT,
  PRIMARY KEY (request_id, phase)
);
`;

export type Phase = "preflight_24h" | "preflight_10m" | "release";

function now(): string {
  return DateTime.now().setZone(TZ).toISO()!;
}

export class Store {
  readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
  }

  upsertRequest(req: ReservationRequest, releaseAt: DateTime): void {
    const existing = this.getRequest(req.id);
    if (existing && !["draft", "scheduled", "preflight_ok", "failed"].includes(existing.status)) {
      throw new Error(`request ${req.id} is ${existing.status}; refusing to overwrite`);
    }
    this.db
      .prepare(
        `INSERT INTO reservation_requests (id, provider, facility, target_date, duration_minutes, preferences_json, max_price, release_json, release_at, mode, status, updated_at)
         VALUES (@id, @provider, @facility, @targetDate, @durationMinutes, @prefs, @maxPrice, @release, @releaseAt, @mode, @status, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET provider=excluded.provider, facility=excluded.facility, target_date=excluded.target_date,
           duration_minutes=excluded.duration_minutes, preferences_json=excluded.preferences_json, max_price=excluded.max_price,
           release_json=excluded.release_json, release_at=excluded.release_at, mode=excluded.mode, status=excluded.status, updated_at=excluded.updated_at`,
      )
      .run({
        id: req.id,
        provider: req.provider,
        facility: req.facility,
        targetDate: req.targetDate,
        durationMinutes: req.durationMinutes,
        prefs: JSON.stringify(req.preferences),
        maxPrice: req.maxPrice,
        release: JSON.stringify(req.release),
        releaseAt: releaseAt.setZone(TZ).toISO(),
        mode: req.mode,
        status: req.status,
        updatedAt: now(),
      });
  }

  getRequest(id: string): (ReservationRequest & { releaseAt: string; runToken: string | null }) | null {
    const r = this.db.prepare(`SELECT * FROM reservation_requests WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      id: r.id as string,
      provider: r.provider as string,
      facility: r.facility as string,
      targetDate: r.target_date as string,
      durationMinutes: r.duration_minutes as number,
      preferences: JSON.parse(r.preferences_json as string),
      maxPrice: (r.max_price as number | null) ?? null,
      release: JSON.parse(r.release_json as string),
      mode: r.mode as ReservationRequest["mode"],
      status: r.status as RequestStatus,
      releaseAt: r.release_at as string,
      runToken: (r.run_token as string | null) ?? null,
    };
  }

  listRequests(statuses?: RequestStatus[]): ReturnType<Store["getRequest"]>[] {
    const rows = this.db.prepare(`SELECT id FROM reservation_requests ORDER BY release_at`).all() as { id: string }[];
    return rows.map((r) => this.getRequest(r.id)).filter((r) => r && (!statuses || statuses.includes(r.status)));
  }

  /** 期待状態からの条件付き遷移。成功時 true */
  transition(id: string, from: RequestStatus[], to: RequestStatus, runToken?: string): boolean {
    const placeholders = from.map(() => "?").join(",");
    const info = this.db
      .prepare(`UPDATE reservation_requests SET status = ?, run_token = COALESCE(?, run_token), updated_at = ? WHERE id = ? AND status IN (${placeholders})`)
      .run(to, runToken ?? null, now(), id, ...from);
    return info.changes === 1;
  }

  recordAttempt(requestId: string, runToken: string, candidate: Candidate | null, result: string, category: ErrorCategory | null, detail: string): void {
    this.db
      .prepare(`INSERT INTO reservation_attempts (request_id, run_token, attempted_at, candidate, result, error_category, detail) VALUES (?,?,?,?,?,?,?)`)
      .run(requestId, runToken, now(), candidate?.label ?? "-", result, category, detail.slice(0, 2000));
  }

  attempts(requestId: string): { attempted_at: string; candidate: string; result: string; error_category: string | null; detail: string }[] {
    return this.db.prepare(`SELECT attempted_at, candidate, result, error_category, detail FROM reservation_attempts WHERE request_id = ? ORDER BY id`).all(requestId) as never;
  }

  /** UNIQUE(request_id) により2件目は例外になる */
  recordReservation(req: ReservationRequest, r: ReservationResult): void {
    this.db
      .prepare(
        `INSERT INTO reservations (request_id, provider, external_reservation_id, facility, space_key, start_at, end_at, price, status, final_url) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(req.id, req.provider, r.externalReservationId, req.facility, r.spaceKey, r.start.toISO(), r.end.toISO(), r.price, "confirmed", r.finalUrl);
  }

  reservationFor(requestId: string): { external_reservation_id: string | null; start_at: string; end_at: string } | null {
    return (this.db.prepare(`SELECT * FROM reservations WHERE request_id = ?`).get(requestId) as never) ?? null;
  }

  setSession(provider: string, state: "valid" | "invalid" | "unknown", detail: string, expiresAt: string | null = null): void {
    this.db
      .prepare(
        `INSERT INTO session_status (provider, last_validated_at, expires_at, state, detail) VALUES (?,?,?,?,?)
         ON CONFLICT(provider) DO UPDATE SET last_validated_at=excluded.last_validated_at, expires_at=excluded.expires_at, state=excluded.state, detail=excluded.detail`,
      )
      .run(provider, now(), expiresAt, state, detail);
  }

  ensurePhases(requestId: string, phases: { phase: Phase; dueAt: DateTime }[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO job_phases (request_id, phase, due_at) VALUES (?,?,?)
       ON CONFLICT(request_id, phase) DO UPDATE SET due_at = excluded.due_at WHERE job_phases.fired_at IS NULL`,
    );
    for (const p of phases) stmt.run(requestId, p.phase, p.dueAt.setZone(TZ).toISO());
  }

  /** フェーズの発火権を取る。既に発火済みなら false */
  claimPhase(requestId: string, phase: Phase): boolean {
    return this.db.prepare(`UPDATE job_phases SET fired_at = ? WHERE request_id = ? AND phase = ? AND fired_at IS NULL`).run(now(), requestId, phase).changes === 1;
  }

  finishPhase(requestId: string, phase: Phase, result: string): void {
    this.db.prepare(`UPDATE job_phases SET result = ? WHERE request_id = ? AND phase = ?`).run(result, requestId, phase);
  }

  pendingPhases(): { request_id: string; phase: Phase; due_at: string; fired_at: string | null; result: string | null }[] {
    return this.db
      .prepare(
        `SELECT p.* FROM job_phases p JOIN reservation_requests r ON r.id = p.request_id
         WHERE r.status IN ('scheduled','preflight_ok','manual_intervention_required') ORDER BY p.due_at`,
      )
      .all() as never;
  }

  /** 未発火フェーズのうち最も早い期日 */
  nextDue(): DateTime | null {
    const r = this.db
      .prepare(
        `SELECT MIN(p.due_at) AS due FROM job_phases p JOIN reservation_requests r ON r.id = p.request_id
         WHERE p.fired_at IS NULL AND r.status IN ('scheduled','preflight_ok')`,
      )
      .get() as { due: string | null };
    return r.due ? DateTime.fromISO(r.due, { zone: TZ }) : null;
  }

  close(): void {
    this.db.close();
  }
}
