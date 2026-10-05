/**
 * ドメインモデルとProvider共通interface。
 * サイト固有のURL・DOM・操作手順はここへ持ち込まない（providers/ 配下に閉じる）。
 */
import type { DateTime } from "luxon";

export const TZ = "Asia/Tokyo" as const;

export type Mode = "dry-run" | "assist" | "auto";

export type RequestStatus =
  | "draft"
  | "scheduled"
  | "preflight_ok"
  | "running"
  | "completed"
  | "failed"
  | "manual_intervention_required"
  | "cancelled";

/** 解禁ルール。Providerごとの違いはStrategyで吸収する（release-policy.ts）。 */
export type ReleaseRule =
  | { type: "days_before"; days: number; time: string; timezone: typeof TZ }
  | { type: "monthly_window"; monthsAhead: number; openDay: number; time: string; timezone: typeof TZ }
  | { type: "fixed"; at: string; timezone: typeof TZ };

export interface ReservationRequest {
  id: string;
  provider: string;
  facility: string;
  /** YYYY-MM-DD（Asia/Tokyo の暦日） */
  targetDate: string;
  durationMinutes: number;
  preferences: {
    /** court/room の希望順（Provider固有キー。例: labola の "covered"） */
    spacePriority: string[];
    /** 開始時刻 "HH:mm" の希望順 */
    timePriority: string[];
    /** true: 時刻を優先して空間を回す / false: 空間を優先して時刻を回す */
    timeFirst: boolean;
  };
  maxPrice: number | null;
  release: ReleaseRule;
  mode: Mode;
  status: RequestStatus;
}

/** 試行単位。duration が複数枠にまたがる場合も1候補として扱う（部分予約を防ぐため）。 */
export interface Candidate {
  rank: number;
  spaceKey: string;
  start: DateTime;
  end: DateTime;
  label: string;
}

export type SlotState =
  | "available"
  | "booked"
  | "blocked" // スクール・施設利用等
  | "not_released"
  | "closed" // 営業時間外
  | "unknown";

export interface Slot {
  spaceKey: string;
  start: DateTime;
  end: DateTime;
  state: SlotState;
  /** Provider内部で予約に使う参照（URL等）。core は中身を解釈しない */
  ref?: string;
  price?: number;
}

export interface AvailabilitySnapshot {
  fetchedAt: DateTime;
  slots: Slot[];
}

export type ErrorCategory =
  | "NO_AVAILABILITY"
  | "SLOT_TAKEN"
  | "NOT_RELEASED"
  | "PRICE_EXCEEDED"
  | "SESSION_EXPIRED"
  | "RATE_LIMITED" // 429
  | "FORBIDDEN" // 403（CSRF含む。ループさせない）
  | "SERVER_ERROR" // 5xx
  | "NETWORK"
  | "CAPTCHA" // 回避しない。停止して通知
  | "AUTH_CHALLENGE" // 3-Dセキュア等の本人認証。自動で通過しない
  | "SITE_CHANGED" // selector破損・想定外のページ。「空きなし」と区別する
  | "UNCERTAIN_SUBMISSION" // 送信後に結果を確認できない。二重予約防止のため停止
  | "MODE_STOP" // dry-run/assist で意図的に止めた
  | "UNKNOWN";

export class ProviderError extends Error {
  constructor(
    readonly category: ErrorCategory,
    message: string,
    /** 予約確定ボタンを押した後か。true なら同一リクエストで他候補へ進まない */
    readonly submitted = false,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface ReservationResult {
  externalReservationId: string | null;
  spaceKey: string;
  start: DateTime;
  end: DateTime;
  price: number | null;
  finalUrl: string;
}

export interface SessionCheck {
  valid: boolean;
  detail: string;
}

export interface Evidence {
  label: string;
  screenshotPath: string | null;
  url: string | null;
  capturedAt: DateTime;
}

/** Provider共通interface。core はこれだけを呼ぶ。 */
export interface ProviderAdapter {
  readonly id: string;

  /** 施設ごとの既定解禁ルール。request側で上書き可能 */
  defaultReleaseRule(facility: string): ReleaseRule | null;

  authenticate(): Promise<void>;
  validateSession(): Promise<SessionCheck>;

  /** 対象日の空き。ページ構造が想定と違えば SITE_CHANGED を投げる（空配列を返さない） */
  getAvailability(req: ReservationRequest): Promise<AvailabilitySnapshot>;

  /**
   * 候補を予約する。mode に応じて途中で止める。
   * - dry-run: 呼ばれない
   * - assist: 確認画面で止め MODE_STOP を投げる
   * - auto: 確定まで行う
   */
  reserve(req: ReservationRequest, candidate: Candidate, snapshot: AvailabilitySnapshot, mode: Mode): Promise<ReservationResult>;

  /** 二重予約防止の照合。サイト上に同一日の既存予約があれば返す */
  findExistingReservation(req: ReservationRequest): Promise<ReservationResult | null>;

  /** 本番前の構造確認（ページ到達・selector有効性） */
  preflight(req: ReservationRequest): Promise<{ ok: boolean; checks: { name: string; ok: boolean; detail: string }[] }>;

  captureEvidence(label: string): Promise<Evidence>;

  /** 価格の算出（料金表）。不明なら null */
  estimatePrice(req: ReservationRequest, candidate: Candidate): number | null;

  /** 候補を構成する枠。duration を満たす連続枠を返す。満たせなければ null */
  slotsForCandidate(snapshot: AvailabilitySnapshot, candidate: Candidate): Slot[] | null;

  close(): Promise<void>;
}
