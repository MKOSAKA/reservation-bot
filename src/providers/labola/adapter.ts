/**
 * LaBOLA Provider Adapter。
 *
 * 実装状況（2026-10-05）:
 *   - 空き取得（公開カレンダー）: 実装済み・実ページ構造で確認済み
 *   - ログイン〜STEP4（内容確認）: 2026-10-05 にユーザー本人のブラウザで観測し実装（flow.ts）
 *   - 確定（STEP5）以降: 未観測。LABOLA_ALLOW_SUBMIT=1 の時だけ押す。実予約テスト合格まで有効にしない
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
import { identifyStep, looksSlotTaken, parseAmount, parseBookingRow, parseReservationNumber, type FlowStep } from "./flow.js";
import { LABOLA_FACILITIES, type LabolaFacility } from "./facilities.js";

const BASE = "https://yoyaku.labola.jp";
/** ログイン後の予約フローをマッピング済みか。未確認のまま auto で確定ボタンを押さないためのガード */
export const FLOW_MAPPED = true; // 2026-10-05 STEP4 まで観測済み。確定は LABOLA_ALLOW_SUBMIT=1 でのみ

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

  /**
   * @param opts.loginRequired ログイン必須ページ。未ログイン時は 404 が返る（2026-10-05 実測）ため SESSION_EXPIRED とみなす
   */
  private async goto(page: Page, url: string, opts: { loginRequired?: boolean } = {}): Promise<Response | null> {
    let res: Response | null;
    try {
      res = await page.goto(url, { waitUntil: "domcontentloaded" });
    } catch (e) {
      throw new ProviderError("NETWORK", (e as Error).message);
    }
    const status = res?.status() ?? null;
    if (opts.loginRequired && (status === 401 || status === 404)) throw new ProviderError("SESSION_EXPIRED", `HTTP ${status}（未ログイン）`);
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
    // 送信ボタンは <input type="submit">（name なし）。同ページの「LaBOLAアカウントでログイン」とは別フォームなので、ID欄を含むフォームに限定する
    const submit = page.locator('form:has(input[name="membership_code"]) [type="submit"]').first();
    if ((await submit.count()) === 0) throw new ProviderError("SITE_CHANGED", "login submit button not found");
    const [res] = await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded" }).catch(() => null), submit.click()]);
    const body = (await page.locator("body").innerText()).slice(0, 5000);
    const err = categorizeResponse(res?.status() ?? null, body);
    if (err) throw err;
    if ((await page.locator('input[name="password"]').count()) > 0) throw new ProviderError("SESSION_EXPIRED", "login rejected (form still shown)");
    await this.sessions.saveState();
  }

  async validateSession(): Promise<SessionCheck> {
    // 予約一覧はログイン時のみ表示され、ログアウト導線を持つ
    const page = await this.sessions.getPage();
    try {
      await this.goto(page, `${BASE}/r/customer/member-bookings/`, { loginRequired: true });
    } catch (e) {
      if (e instanceof ProviderError && e.category === "SESSION_EXPIRED") return { valid: false, detail: e.message };
      throw e;
    }
    const loggedIn = (await page.locator('a[href^="/r/customer/logout/"]').count()) > 0;
    const loginForm = (await page.locator('input[name="membership_code"]').count()) > 0;
    if (loggedIn && !loginForm) return { valid: true, detail: "member-bookings reachable (logout link present)" };
    return { valid: false, detail: loginForm ? "login form shown" : "logout link not found" };
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
    try {
      await this.findExistingReservation(req);
      checks.push({ name: "member-bookings", ok: true, detail: "parsed" });
    } catch (e) {
      const pe = e as ProviderError;
      checks.push({ name: "member-bookings", ok: false, detail: `${pe.category ?? "UNKNOWN"} ${pe.message}` });
    }
    const cvv = this.cardCvv();
    checks.push({ name: "card-cvv", ok: Boolean(cvv), detail: cvv ? "configured" : "LABOLA_CARD_CVV 未設定（STEP3で停止する）" });
    if (req.mode === "auto") {
      checks.push({ name: "submit-guard", ok: this.submitAllowed(), detail: this.submitAllowed() ? "LABOLA_ALLOW_SUBMIT=1" : "LABOLA_ALLOW_SUBMIT が1でないため確定しない" });
    }
    return { ok: checks.every((c) => c.ok), checks };
  }

  private cardCvv(): string | null {
    const v = process.env.LABOLA_CARD_CVV;
    return v && /^\d{3,4}$/.test(v) ? v : null;
  }

  /** 実予約テストに合格するまで確定ボタンを押さないための二重ガード */
  private submitAllowed(): boolean {
    return FLOW_MAPPED && process.env.LABOLA_ALLOW_SUBMIT === "1";
  }

  private async step(page: Page): Promise<FlowStep> {
    const body = (await page.locator("body").innerText().catch(() => "")).slice(0, 8000);
    const hasLogin = (await page.locator('input[name="membership_code"]').count()) > 0;
    return identifyStep(await page.title(), new URL(page.url()).pathname, hasLogin, body);
  }

  private async expectStep(page: Page, want: FlowStep, submitted = false): Promise<void> {
    const got = await this.step(page);
    if (got === want) return;
    const body = (await page.locator("body").innerText().catch(() => "")).slice(0, 8000);
    if (got === "login") throw new ProviderError("SESSION_EXPIRED", `login required (expected ${want})`, submitted);
    if (got === "three_ds") throw new ProviderError("AUTH_CHALLENGE", "3-D Secure / 本人認証が要求された", submitted);
    const err = categorizeResponse(null, body);
    if (err) throw new ProviderError(err.category, err.message, submitted);
    if (!submitted && looksSlotTaken(body)) throw new ProviderError("SLOT_TAKEN", `slot taken (at ${want})`);
    throw new ProviderError(submitted ? "UNCERTAIN_SUBMISSION" : "SITE_CHANGED", `unexpected page: expected ${want}, got ${got}`, submitted);
  }

  /** フォーム送信してページ遷移を待つ */
  private async submit(page: Page, selector: string): Promise<void> {
    const btn = page.locator(selector).first();
    if ((await btn.count()) === 0) throw new ProviderError("SITE_CHANGED", `button not found: ${selector}`);
    try {
      await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30_000 }), btn.click()]);
    } catch (e) {
      throw new ProviderError("NETWORK", (e as Error).message);
    }
  }

  async reserve(req: ReservationRequest, c: Candidate, snapshot: AvailabilitySnapshot, mode: Mode): Promise<ReservationResult> {
    const f = facilityOf(req.facility);
    const space = f.spaces[c.spaceKey]!;
    const slots = this.slotsForCandidate(snapshot, c);
    if (!slots || slots.some((s) => s.state !== "available")) throw new ProviderError("NO_AVAILABILITY", "candidate not available");
    const page = await this.sessions.getPage();

    // STEP1 予約内容: 開始・終了を選ぶ（2時間も1予約で取れる）
    await this.goto(page, new URL(slots[0]!.ref!, BASE).toString());
    await this.expectStep(page, "step1");
    const startV = c.start.toFormat("HHmm");
    const endV = c.end.toFormat("HHmm");
    for (const [name, v] of [["start", startV], ["end", endV]] as const) {
      const sel = page.locator(`select[name="${name}"]`);
      if ((await sel.count()) !== 1) throw new ProviderError("SITE_CHANGED", `select[name=${name}] not found`);
      const has = await sel.locator(`option[value="${v}"]`).count();
      if (!has) throw new ProviderError("SLOT_TAKEN", `${name}=${v} is not selectable`);
      await sel.selectOption(v);
    }
    await page.waitForTimeout(800); // 金額の再計算（jQuery）を待つ
    const amount = parseAmount(await page.locator("body").innerText());
    if (amount === null) throw new ProviderError("SITE_CHANGED", "amount not found on STEP1");
    if (req.maxPrice !== null && amount > req.maxPrice) throw new ProviderError("PRICE_EXCEEDED", `amount ${amount} > ${req.maxPrice}`);
    await this.submit(page, '[name="submit_conf"]');

    // STEP2 予約者情報（登録済み情報の確認のみ）
    if ((await this.step(page)) === "step2") {
      await this.submit(page, 'form [type="submit"]');
    }

    // STEP3 お支払い: 登録済みカード + セキュリティコード
    await this.expectStep(page, "step3");
    const prev = page.locator('input[name="zeus_card_option"][value="prev"]');
    if ((await prev.count()) !== 1) throw new ProviderError("SITE_CHANGED", "registered-card option not found");
    const cvv = this.cardCvv();
    if (!cvv) throw new ProviderError(mode === "assist" ? "MODE_STOP" : "SITE_CHANGED", "LABOLA_CARD_CVV not configured");
    await prev.check();
    await page.locator('input[name="zeus_token_card_cvv_for_registerd_card"]').fill(cvv);
    await this.submit(page, '[name="submit_ok"]');

    // STEP4 内容確認: 日時・スペース・金額を照合してから同意
    await this.expectStep(page, "step4");
    const confirmText = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    const dateJa = `${c.start.year}年${c.start.month}月${c.start.day}日`;
    if (!confirmText.includes(dateJa) || !confirmText.includes(c.start.toFormat("HH:mm")) || !confirmText.includes(space.label)) {
      throw new ProviderError("SITE_CHANGED", "confirmation page does not match the candidate");
    }
    const finalAmount = parseAmount(confirmText);
    if (req.maxPrice !== null && finalAmount !== null && finalAmount > req.maxPrice) throw new ProviderError("PRICE_EXCEEDED", `amount ${finalAmount}`);
    for (const name of ["agree-tos", "agree-pp"]) {
      const cb = page.locator(`input[type="checkbox"][name="${name}"]`);
      if ((await cb.count()) !== 1) throw new ProviderError("SITE_CHANGED", `checkbox ${name} not found`);
      await cb.check();
    }
    if (mode !== "auto" || !this.submitAllowed()) {
      throw new ProviderError("MODE_STOP", `stopped at STEP4 (mode=${mode}, submitAllowed=${this.submitAllowed()})`);
    }

    // ここから先は送信済み扱い。失敗しても他候補へ進まない
    try {
      await this.submit(page, '[name="submit_ok"]');
    } catch (e) {
      throw new ProviderError("UNCERTAIN_SUBMISSION", (e as Error).message, true);
    }
    await this.expectStep(page, "complete", true);
    await this.captureEvidence("complete").catch(() => undefined);
    const confirmed = await this.findExistingReservation(req).catch(() => null);
    if (!confirmed) throw new ProviderError("UNCERTAIN_SUBMISSION", "completion page shown but booking not found in member-bookings", true);
    return { ...confirmed, finalUrl: safeUrl(page.url()) ?? confirmed.finalUrl };
  }

  /** 予約一覧で、対象日・同施設の有効な予約を探す（二重予約防止の照合） */
  async findExistingReservation(req: ReservationRequest): Promise<ReservationResult | null> {
    const f = facilityOf(req.facility);
    const page = await this.sessions.getPage();
    await this.goto(page, `${BASE}/r/customer/member-bookings/`, { loginRequired: true });
    if ((await page.locator('input[name="membership_code"]').count()) > 0) throw new ProviderError("SESSION_EXPIRED", "member-bookings requires login");
    const rows = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href*="/r/customer/member-booking/rental/"]')).map((a) => ({
        href: a.getAttribute("href") ?? "",
        text: (a.closest("tr, li, .row, div")?.textContent ?? "").replace(/\s+/g, " ").slice(0, 400),
      })),
    );
    const labels = new Map(Object.entries(f.spaces).map(([k, s]) => [s.label, k]));
    for (const row of rows) {
      const b = parseBookingRow(row);
      if (!b || b.cancelled || b.start.toISODate() !== req.targetDate) continue;
      const spaceKey = labels.get(b.spaceLabel);
      if (!spaceKey) continue;
      await this.goto(page, new URL(b.detailPath, BASE).toString());
      const id = parseReservationNumber(await page.locator("body").innerText());
      return { externalReservationId: id, spaceKey, start: b.start, end: b.end, price: b.price, finalUrl: safeUrl(page.url()) ?? "" };
    }
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
