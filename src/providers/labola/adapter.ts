/**
 * LaBOLA Provider Adapter。
 *
 * 実装状況（2026-10-05）:
 *   - 空き取得（公開カレンダー）: 実装済み・実ページ構造で確認済み
 *   - ログイン〜予約確定: 「施設メンバーログイン」以降の画面はログインしないと見えないため未マッピング。
 *     FLOW_MAPPED=false の間、reserve() は確認画面へ進まず SITE_CHANGED（未対応）で停止する。
 *     マッピングはユーザーのアカウントで assist 相当の手動確認を1回行ってから埋める（docs/ops 参照）。
 *
 * アクセス方針: 人間の操作相当の低頻度に限る。並列取得・高頻度ポーリングはしない。
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DateTime } from "luxon";
import type { Page, Response } from "playwright";
import { safeUrl } from "../../core/logger.js";
import type { SessionManager } from "../../core/session-manager.js";
import { resolveCandidateSlots } from "../../core/slots.js";
import {
  ProviderError,
  TZ,
  type AvailabilitySnapshot,
  type Candidate,
  type Evidence,
  type Mode,
  type ProviderAdapter,
  type ReservationRequest,
  type ReservationResult,
  type SessionCheck,
  type Slot,
} from "../../core/types.js";
import { parseDay, priceFor, type RawCalendar } from "./calendar.js";
import { LABOLA_FACILITIES, type LabolaFacility } from "./facilities.js";

const BASE = "https://yoyaku.labola.jp";
/** ログイン後の予約フローをマッピング済みか。未確認のまま auto で確定ボタンを押さないためのガード */
export const FLOW_MAPPED = false;

function facilityOf(key: string): LabolaFacility {
  const f = LABOLA_FACILITIES[key];
  if (!f) throw new ProviderError("SITE_CHANGED", `unknown labola facility "${key}"`);
  return f;
}

/** HTTP ステータスとページ内容からエラー区分を決める */
export function categorizeResponse(status: number | null, bodyText: string): ProviderError | null {
  if (/captcha|recaptcha|hcaptcha|turnstile|私はロボットではありません/i.test(bodyText)) return new ProviderError("CAPTCHA", "CAPTCHA detected");
  if (/CSRF/i.test(bodyText)) return new ProviderError("FORBIDDEN", "CSRF verification failed");
  if (status === null) return null;
  if (status === 429) return new ProviderError("RATE_LIMITED", "HTTP 429");
  if (status === 403) return new ProviderError("FORBIDDEN", "HTTP 403");
  if (status >= 500) return new ProviderError("SERVER_ERROR", `HTTP ${status}`);
  if (status >= 400) return new ProviderError("SITE_CHANGED", `HTTP ${status}`);
  return null;
}

export class LabolaAdapter implements ProviderAdapter {
  readonly id = "labola";

  constructor(
    private readonly sessions: SessionManager,
    private readonly evidenceDir: string,
    private readonly credentials: () => { memberId: string; password: string } | null,
  ) {}

  defaultReleaseRule(facility: string) {
    return facilityOf(facility).release;
  }

  private async goto(page: Page, url: string): Promise<Response | null> {
    let res: Response | null;
    try {
      res = await page.goto(url, { waitUntil: "domcontentloaded" });
    } catch (e) {
      throw new ProviderError("NETWORK", (e as Error).message);
    }
    const body = (await page.locator("body").innerText().catch(() => "")).slice(0, 5000);
    const err = categorizeResponse(res?.status() ?? null, body);
    if (err) throw err;
    return res;
  }

  private calendarUrl(f: LabolaFacility, spaceId: number, date: string): string {
    const d = DateTime.fromISO(date, { zone: TZ });
    return `${BASE}/r/shop/${f.shopId}/calendar_week/${d.year}/${d.month}/${d.day}/?space_id=${spaceId}`;
  }

  /** DOM から RawCalendar を抜き出す。判定は calendar.ts（純粋関数）で行う */
  private async extractCalendar(page: Page): Promise<RawCalendar> {
    return page.evaluate(() => {
      const table = Array.from(document.querySelectorAll("table")).find((t) => t.querySelector("td.court"));
      if (!table) return { gridStart: "", minutesPerColumn: 0, rows: [] };
      const firstHour = table.querySelector("td.hour.h00, th.hour.h00, .hour.h00");
      const halfHour = table.querySelector(".hour.h30") as HTMLTableCellElement | null;
      const rows = Array.from(table.querySelectorAll("tr"))
        .filter((r) => r.querySelector("td.court"))
        .map((r) => ({
          dayLabel: (r.querySelector("th")?.textContent ?? "").replace(/\s+/g, ""),
          court: (r.querySelector("td.court")?.textContent ?? "").replace(/\s+/g, ""),
          cells: Array.from(r.querySelectorAll("td.slot")).map((c) => ({
            classes: Array.from(c.classList),
            colspan: (c as HTMLTableCellElement).colSpan || 1,
            link: (c as HTMLElement).dataset.link ?? null,
            text: (c.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40),
          })),
        }));
      return {
        gridStart: (firstHour?.textContent ?? "").trim().slice(0, 5),
        minutesPerColumn: halfHour && halfHour.colSpan > 0 ? 30 / halfHour.colSpan : 0,
        rows,
      };
    });
  }

  async getAvailability(req: ReservationRequest): Promise<AvailabilitySnapshot> {
    const f = facilityOf(req.facility);
    const page = await this.sessions.getPage();
    const slots: Slot[] = [];
    for (const key of req.preferences.spacePriority) {
      const space = f.spaces[key];
      if (!space) throw new ProviderError("SITE_CHANGED", `unknown space "${key}" for ${f.key}`);
      await this.goto(page, this.calendarUrl(f, space.spaceId, req.targetDate));
      const raw = await this.extractCalendar(page);
      slots.push(...parseDay(raw, req.targetDate, key, space.spaceId, space.label));
    }
    return { fetchedAt: DateTime.now().setZone(TZ), slots };
  }

  slotsForCandidate(snapshot: AvailabilitySnapshot, c: Candidate): Slot[] | null {
    return resolveCandidateSlots(snapshot.slots, c);
  }

  estimatePrice(req: ReservationRequest, c: Candidate): number | null {
    const f = facilityOf(req.facility);
    const s = f.spaces[c.spaceKey];
    return s ? priceFor(s.prices, c.start, c.end, f.holidays) : null;
  }

  async authenticate(): Promise<void> {
    // 施設メンバーログイン（会員番号/メール + パスワード）。1回だけ試み、失敗してもループしない。
    const cred = this.credentials();
    if (!cred) throw new ProviderError("SESSION_EXPIRED", "LABOLA_MEMBER_ID / LABOLA_PASSWORD が未設定");
    const f = facilityOf("morinomiya");
    const page = await this.sessions.getPage();
    await this.goto(page, `${BASE}/r/shop/${f.shopId}/member/login/`);
    const id = page.locator('input[name="membership_code"]');
    const pw = page.locator('input[name="password"]');
    if ((await id.count()) !== 1 || (await pw.count()) !== 1) throw new ProviderError("SITE_CHANGED", "login form fields not found");
    await id.fill(cred.memberId);
    await pw.fill(cred.password);
    const [res] = await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded" }).catch(() => null), page.locator('[name="submit_member"], button[type="submit"]').first().click()]);
    const body = (await page.locator("body").innerText()).slice(0, 5000);
    const err = categorizeResponse(res?.status() ?? null, body);
    if (err) throw err;
    if ((await page.locator('input[name="password"]').count()) > 0) throw new ProviderError("SESSION_EXPIRED", "login rejected (form still shown)");
    await this.sessions.saveState();
  }

  async validateSession(): Promise<SessionCheck> {
    // TODO(フロー確認後): ログイン済みでのみ表示される要素（マイページ導線等）で判定する。
    // 現状はログインフォームが出ないことだけを確認する暫定実装。
    const f = facilityOf("morinomiya");
    const page = await this.sessions.getPage();
    await this.goto(page, `${BASE}/r/shop/${f.shopId}/member/login/`);
    const loginForm = await page.locator('input[name="membership_code"]').count();
    return loginForm === 0 ? { valid: true, detail: "login form not shown (暫定判定)" } : { valid: false, detail: "login form shown" };
  }

  async preflight(req: ReservationRequest) {
    const checks: { name: string; ok: boolean; detail: string }[] = [];
    try {
      const snap = await this.getAvailability(req);
      const byState = snap.slots.reduce<Record<string, number>>((a, s) => ((a[s.state] = (a[s.state] ?? 0) + 1), a), {});
      checks.push({ name: "calendar", ok: true, detail: JSON.stringify(byState) });
    } catch (e) {
      const pe = e as ProviderError;
      checks.push({ name: "calendar", ok: false, detail: `${pe.category ?? "UNKNOWN"} ${pe.message}` });
    }
    checks.push({
      name: "booking-flow",
      ok: FLOW_MAPPED,
      detail: FLOW_MAPPED ? "mapped" : "ログイン後の予約フローが未マッピング（auto不可）",
    });
    return { ok: checks.every((c) => c.ok), checks };
  }

  async reserve(req: ReservationRequest, c: Candidate, snapshot: AvailabilitySnapshot, mode: Mode): Promise<ReservationResult> {
    const slots = this.slotsForCandidate(snapshot, c);
    if (!slots || slots.some((s) => s.state !== "available")) throw new ProviderError("NO_AVAILABILITY", "candidate not available");
    const first = slots[0]!;
    const page = await this.sessions.getPage();
    await this.goto(page, new URL(first.ref!, BASE).toString());
    if ((await page.locator('input[name="membership_code"]').count()) > 0) {
      throw new ProviderError("SESSION_EXPIRED", "booking page requires login");
    }
    if (!FLOW_MAPPED) {
      // ここから先（2時間連続枠の指定・人数・決済・規約同意・確定）は未確認。推測で操作しない。
      throw new ProviderError(mode === "assist" ? "MODE_STOP" : "SITE_CHANGED", "post-login booking flow not mapped yet");
    }
    throw new ProviderError("SITE_CHANGED", "unreachable");
  }

  async findExistingReservation(_req: ReservationRequest): Promise<ReservationResult | null> {
    // TODO(フロー確認後): マイページ「予約状況」で同日・同施設の予約を照合する。
    // 未実装の間に auto へ進ませないため、FLOW_MAPPED=false なら例外にする。
    if (!FLOW_MAPPED) throw new ProviderError("SITE_CHANGED", "existing-reservation check not mapped yet");
    return null;
  }

  async captureEvidence(label: string): Promise<Evidence> {
    const page = await this.sessions.getPage();
    const now = DateTime.now().setZone(TZ);
    const dir = join(this.evidenceDir, now.toFormat("yyyy-MM-dd"));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `${now.toFormat("HHmmss.SSS")}-labola-${label}.png`);
    await page.screenshot({
      path,
      fullPage: true,
      // 個人情報・認証情報の入力欄はマスクする
      mask: [page.locator('input[type="password"]'), page.locator('input[name*="mail"]'), page.locator('input[name*="tel"]'), page.locator('input[name*="name"]')],
    });
    return { label, screenshotPath: path, url: safeUrl(page.url()), capturedAt: now };
  }

  async close(): Promise<void> {
    await this.sessions.close();
  }
}
