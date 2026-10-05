/**
 * スタジオル Provider Adapter。
 *
 * 予約の流れ（2026-10-05 にユーザー本人のブラウザで確定の手前まで観測）:
 *   1. 店舗ページ /shop/{id} のカレンダーで時間を選ぶ → モーダル「予約時間確認」（開始・終了・利用人数）
 *   2. 「予約情報の詳細に進む」→ /reserve/{roomId}「予約設定」（オプション機材・アンケート）
 *   3. 「予約の確認に進む」→ /reserve_check「予約最終確認」（hidden: room_id / date_time_start / date_time_end / people_num、合計料金）
 *   4. 「上記の内容で予約を確定する」→ POST /reserve_complete（確定。STUDIOL_ALLOW_SUBMIT=1 の時だけ押す）
 * 決済は確定時に発生しない（店頭またはオンライン決済を後から選ぶ）。
 *
 * カレンダーの操作はページ自身の FullCalendar（jQuery プラグイン）を使う。非公開APIを直接は呼ばない。
 * アクセスは人の操作相当に限る（規約第10条: 短期間の大量予約・システムへの負荷の禁止）。
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DateTime } from "luxon";
import type { Page, Response } from "playwright";
import { safeUrl } from "../../core/logger.js";
import type { SessionManager } from "../../core/session-manager.js";
import { candidatesFor } from "../../core/reservation-engine.js";
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
import { categorizeResponse } from "../labola/adapter.js";
import { STUDIOL_FACILITIES, type StudiolFacility } from "./facilities.js";
import { checkResources, formatStudiolDateTime, parseDaySlots, parseTotal, parseUserReservation, type RawEvent, type RawResource } from "./parse.js";

const BASE = "https://studi-ol.com";
const SLOT_TAKEN_RE = /既に予約|予約できません|予約が入って|空きがありません|選択できません|埋まって/;

/**
 * ログイン失敗の説明（ログ・通知に出してよい形）。
 * 入力したメールアドレス・パスワードが画面の文言に含まれていても伏せる。
 */
export function describeLoginFailure(
  status: number | null,
  url: string,
  title: string,
  messages: string[],
  cred: { email: string; password: string },
): string {
  const mask = (s: string) => [cred.email, cred.password].filter((v) => v.length > 0).reduce((t, v) => t.split(v).join("***"), s);
  const uniq = [...new Set(messages.map(mask))].slice(0, 5).map((m) => m.slice(0, 120));
  return [
    "login rejected",
    `status=${status ?? "none"}`,
    `url=${mask(safeUrl(url) ?? "")}`,
    title ? `title=${mask(title).slice(0, 80)}` : null,
    uniq.length ? `messages=${JSON.stringify(uniq)}` : "messages=[]",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * get_schedule_shop の POST 本文が対象日の取得か（2026-10-05 観測: start=2027-01-16 00:00:00&end=2027-01-17 07:00:00）。
 * 本文がフォーム形式・URL エンコード・JSON のいずれでも判定できるようにデコードしてから見る
 */
export function isScheduleRequestFor(postData: string | null, date: string): boolean {
  if (!postData) return false;
  let body = postData;
  try {
    body = decodeURIComponent(postData.replace(/\+/g, " "));
  } catch {
    /* デコードできなければそのまま */
  }
  return new RegExp(`"?start"?\\s*[=:]\\s*"?${date}`).test(body);
}

function facilityOf(key: string): StudiolFacility {
  const f = STUDIOL_FACILITIES[key];
  if (!f) throw new ProviderError("SITE_CHANGED", `unknown studiol facility "${key}"`);
  return f;
}

export class StudiolAdapter implements ProviderAdapter {
  readonly id = "studiol";

  constructor(
    private readonly sessions: SessionManager,
    private readonly evidenceDir: string,
    private readonly credentials: () => { email: string; password: string } | null,
  ) {}

  defaultReleaseRule(facility: string) {
    return facilityOf(facility).release;
  }

  private submitAllowed(): boolean {
    return process.env.STUDIOL_ALLOW_SUBMIT === "1";
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

  private async loggedIn(page: Page): Promise<boolean> {
    return (await page.locator('a[href$="/logout"]').count()) > 0;
  }

  private async openShop(page: Page, f: StudiolFacility): Promise<void> {
    await this.goto(page, `${BASE}/shop/${f.shopId}`);
    if (!(await this.loggedIn(page))) throw new ProviderError("SESSION_EXPIRED", "not logged in (空きはログイン時のみ表示)");
    await page
      .waitForFunction(() => {
        const w = window as unknown as { jQuery?: { (s: string): { length: number }; fn: { fullCalendar?: unknown } } };
        return !!w.jQuery && !!w.jQuery.fn.fullCalendar && w.jQuery(".schedule-calendar0").length > 0;
      }, undefined, { timeout: 15_000 })
      .catch(() => {
        throw new ProviderError("SITE_CHANGED", "calendar (.schedule-calendar0 / FullCalendar) not found");
      });
  }

  /** カレンダーを対象日へ移動し、その日のイベントと部屋構成を読む */
  private async readDay(page: Page, date: string): Promise<{ events: RawEvent[]; resources: RawResource[] }> {
    // 店舗ページを開いた直後は「今日」の分の取得が走っているため、対象日の取得（POST 本文の start=対象日）だけを待つ。
    // 2026-10-05 AWS 実機: URL だけで待つと今日の分の応答で先に進み、対象日のイベント0件＝未解禁と誤判定した
    const [res] = await Promise.all([
      page
        .waitForResponse((r) => r.url().includes("/get_schedule_shop") && isScheduleRequestFor(r.request().postData(), date), { timeout: 15_000 })
        .catch(() => null),
      page.evaluate((d) => {
        const $ = (window as unknown as { jQuery: (s: string) => { fullCalendar: (...a: unknown[]) => unknown } }).jQuery;
        $(".schedule-calendar0").fullCalendar("gotoDate", d);
      }, date),
    ]);
    if (res) {
      const err = categorizeResponse(res.status(), "");
      if (err) throw err;
    }
    // 応答の反映（イベント登録）を待つ。予約可能期間外の日は0件のままなので、短い上限で打ち切る
    await page
      .waitForFunction(
        (d) => {
          const $ = (window as unknown as { jQuery: (s: string) => { fullCalendar: (...a: unknown[]) => unknown } }).jQuery;
          const evs = $(".schedule-calendar0").fullCalendar("clientEvents") as { start: { format: (f: string) => string } }[];
          return evs.some((e) => e.start.format("YYYY-MM-DD") === d);
        },
        date,
        { timeout: res ? 3_000 : 10_000 },
      )
      .catch(() => null);
    return page.evaluate((d) => {
      type Ev = { start: { format: (f: string) => string }; resourceId: string; className?: string | string[]; rendering?: string };
      const $ = (window as unknown as { jQuery: (s: string) => { fullCalendar: (...a: unknown[]) => unknown } }).jQuery;
      const $c = $(".schedule-calendar0");
      const resources = ($c.fullCalendar("getResources") as { id: unknown; title: unknown }[]).map((r) => ({ id: String(r.id), title: String(r.title) }));
      const events = ($c.fullCalendar("clientEvents") as Ev[])
        .filter((e) => e.start.format("YYYY-MM-DD") === d)
        .map((e) => ({
          start: e.start.format("YYYY-MM-DDTHH:mm:ss"),
          resourceId: String(e.resourceId),
          classes: ([] as string[]).concat(e.className ?? []),
          rendering: e.rendering ?? null,
        }));
      return { events, resources };
    }, date);
  }

  async getAvailability(req: ReservationRequest): Promise<AvailabilitySnapshot> {
    const f = facilityOf(req.facility);
    const page = await this.sessions.getPage();
    await this.openShop(page, f);
    const { events, resources } = await this.readDay(page, req.targetDate);
    checkResources(f, resources);
    const slots = parseDaySlots(f, req.preferences.spacePriority, events, req.targetDate);
    return { fetchedAt: DateTime.now().setZone(TZ), slots };
  }

  /** 30分開始の部屋では :00 開始の候補を :30 へずらす（逆も同様に次の開始可能時刻へ） */
  adjustCandidates(req: ReservationRequest, candidates: Candidate[]): Candidate[] {
    const f = facilityOf(req.facility);
    return candidates.map((c) => {
      const room = f.rooms[c.spaceKey];
      if (!room || c.start.minute === room.startMinute) return c;
      const shift = (room.startMinute - c.start.minute + 60) % 60;
      const start = c.start.plus({ minutes: shift });
      const end = c.end.plus({ minutes: shift });
      return { ...c, start, end, label: `${c.spaceKey} ${start.toFormat("HH:mm")}-${end.toFormat("HH:mm")}` };
    });
  }

  slotsForCandidate(snapshot: AvailabilitySnapshot, c: Candidate): Slot[] | null {
    return resolveCandidateSlots(snapshot.slots, c);
  }

  estimatePrice(): number | null {
    return null; // 料金は確認画面の合計で照合する
  }

  async authenticate(): Promise<void> {
    const cred = this.credentials();
    if (!cred) throw new ProviderError("SESSION_EXPIRED", "STUDIOL_EMAIL / STUDIOL_PASSWORD が未設定");
    const f = Object.values(STUDIOL_FACILITIES)[0]!;
    const page = await this.sessions.getPage();
    await this.goto(page, `${BASE}/shop/${f.shopId}`);
    if (await this.loggedIn(page)) {
      await this.sessions.saveState();
      return;
    }
    const form = page.locator('form[action$="/login"]:has(input[type="password"])').first();
    if ((await form.count()) === 0) throw new ProviderError("SITE_CHANGED", "login form not found");
    // ログインフォームはヘッダーのドロップダウン内（非表示）にあるため、値を入れてフォーム自身の送信を使う
    const [nav] = await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }).catch(() => null),
      form.evaluate(
        (el, c) => {
          const f = el as HTMLFormElement;
          (f.querySelector('input[name="email"]') as HTMLInputElement).value = c.email;
          (f.querySelector('input[name="password"]') as HTMLInputElement).value = c.password;
          const remember = f.querySelector('input[name="remember"]') as HTMLInputElement | null;
          if (remember) remember.checked = true;
          f.requestSubmit();
        },
        cred,
      ),
    ]);
    const body = (await page.locator("body").innerText()).slice(0, 5000);
    const err = categorizeResponse(null, body);
    if (err) throw err;
    if (!(await this.loggedIn(page))) {
      // 原因の切り分け用に、遷移先・HTTP ステータス・画面上のエラー文言だけを残す（入力値は伏せる）
      const messages = await page
        .locator(".help-block, .invalid-feedback, .alert, .error, .text-danger")
        .evaluateAll((els) => els.map((e) => (e.textContent ?? "").replace(/\s+/g, " ").trim()).filter(Boolean))
        .catch(() => [] as string[]);
      const title = await page.title().catch(() => "");
      throw new ProviderError("SESSION_EXPIRED", describeLoginFailure(nav?.status() ?? null, page.url(), title, messages, cred));
    }
    await this.sessions.saveState();
  }

  async validateSession(): Promise<SessionCheck> {
    const page = await this.sessions.getPage();
    await this.goto(page, `${BASE}/user`);
    return (await this.loggedIn(page)) ? { valid: true, detail: "logout link present" } : { valid: false, detail: "not logged in" };
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
      checks.push({ name: "user-reservations", ok: true, detail: "parsed" });
    } catch (e) {
      const pe = e as ProviderError;
      checks.push({ name: "user-reservations", ok: false, detail: `${pe.category ?? "UNKNOWN"} ${pe.message}` });
    }
    if (req.mode === "auto") {
      checks.push({ name: "submit-guard", ok: this.submitAllowed(), detail: this.submitAllowed() ? "STUDIOL_ALLOW_SUBMIT=1" : "STUDIOL_ALLOW_SUBMIT が1でないため確定しない" });
    }
    return { ok: checks.every((c) => c.ok), checks };
  }

  private async bodyText(page: Page): Promise<string> {
    return (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");
  }

  private async failUnexpected(page: Page, at: string, submitted = false): Promise<never> {
    const body = await this.bodyText(page);
    const err = categorizeResponse(null, body);
    if (err) throw new ProviderError(err.category, err.message, submitted);
    if (!submitted && SLOT_TAKEN_RE.test(body)) throw new ProviderError("SLOT_TAKEN", `slot taken (${at})`);
    throw new ProviderError(submitted ? "UNCERTAIN_SUBMISSION" : "SITE_CHANGED", `unexpected page at ${at}: ${new URL(page.url()).pathname}`, submitted);
  }

  private async clickAndWait(page: Page, text: string): Promise<void> {
    const btn = page.locator(`button:has-text("${text}"), input[type="submit"][value="${text}"], a:has-text("${text}")`).first();
    if ((await btn.count()) === 0) throw new ProviderError("SITE_CHANGED", `button "${text}" not found`);
    try {
      await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30_000 }), btn.click()]);
    } catch (e) {
      throw new ProviderError("NETWORK", (e as Error).message);
    }
  }

  async reserve(req: ReservationRequest, c: Candidate, snapshot: AvailabilitySnapshot, mode: Mode): Promise<ReservationResult> {
    const f = facilityOf(req.facility);
    const room = f.rooms[c.spaceKey];
    if (!room) throw new ProviderError("SITE_CHANGED", `unknown room ${c.spaceKey}`);
    const slots = this.slotsForCandidate(snapshot, c);
    if (!slots || slots.some((s) => s.state !== "available")) throw new ProviderError("NO_AVAILABILITY", "candidate not available");
    const people = req.preferences.people ?? f.defaultPeople;
    const startStr = formatStudiolDateTime(c.start);
    const endStr = formatStudiolDateTime(c.end);
    const page = await this.sessions.getPage();

    // 1) カレンダーで時間を選ぶ（ページ自身の FullCalendar の select を使う）→ モーダル
    await this.openShop(page, f);
    await this.readDay(page, req.targetDate);
    await page.evaluate(
      ({ s, e, rid }) => {
        const w = window as unknown as { jQuery: (s: string) => { fullCalendar: (...a: unknown[]) => unknown }; moment: (s: string) => unknown };
        w.jQuery(".schedule-calendar0").fullCalendar("select", w.moment(s), w.moment(e), rid);
      },
      { s: c.start.toFormat("yyyy-MM-dd'T'HH:mm:ss"), e: c.end.toFormat("yyyy-MM-dd'T'HH:mm:ss"), rid: room.resourceId },
    );
    const modal = page.locator("#reserveModal");
    await modal.waitFor({ state: "visible", timeout: 10_000 }).catch(() => this.failUnexpected(page, "reserve modal"));
    const vStart = await modal.locator('[name="date_time_start"]').inputValue();
    const vEnd = await modal.locator('[name="date_time_end"]').inputValue();
    if (vStart !== startStr || vEnd !== endStr) throw new ProviderError("SITE_CHANGED", `modal time mismatch: ${vStart}-${vEnd} (expected ${startStr}-${endStr})`);
    await modal.locator('select[name="people_num"]').selectOption(String(people));
    try {
      await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30_000 }), modal.locator('form [type="submit"], form button:has-text("予約情報の詳細に進む")').first().click()]);
    } catch (e) {
      throw new ProviderError("NETWORK", (e as Error).message);
    }

    // 2) 予約設定（オプションは既定のまま、アンケートは「いいえ」= 初めてではない）
    if (!new URL(page.url()).pathname.startsWith(`/reserve/${room.resourceId}`)) await this.failUnexpected(page, "reserve settings");
    const groups = await page.evaluate(() =>
      Array.from(new Set(Array.from(document.querySelectorAll('input[type="radio"][name^="questionnaires"]')).map((e) => (e as HTMLInputElement).name))),
    );
    for (const name of groups) {
      const no = page.locator(`input[type="radio"][name="${name}"][value="いいえ"]`);
      if ((await no.count()) === 1) await no.check();
      else if ((await page.locator(`input[type="radio"][name="${name}"]:checked`).count()) === 0) {
        throw new ProviderError("SITE_CHANGED", `unanswered questionnaire ${name}`);
      }
    }
    await this.clickAndWait(page, "予約の確認に進む");

    // 3) 予約最終確認: hidden の値で照合
    if (!new URL(page.url()).pathname.startsWith("/reserve_check")) await this.failUnexpected(page, "reserve check");
    const form = page.locator('form[action$="/reserve_complete"]');
    if ((await form.count()) !== 1) throw new ProviderError("SITE_CHANGED", "reserve_complete form not found");
    const hidden = async (n: string) => form.locator(`input[name="${n}"]`).inputValue().catch(() => "");
    if ((await hidden("room_id")) !== room.resourceId || (await hidden("date_time_start")) !== startStr || (await hidden("date_time_end")) !== endStr) {
      throw new ProviderError("SITE_CHANGED", "confirmation does not match the candidate");
    }
    const total = parseTotal(await this.bodyText(page));
    if (total === null) throw new ProviderError("SITE_CHANGED", "total price not found");
    if (req.maxPrice !== null && total > req.maxPrice) throw new ProviderError("PRICE_EXCEEDED", `total ${total} > ${req.maxPrice}`);
    if (mode !== "auto" || !this.submitAllowed()) {
      throw new ProviderError("MODE_STOP", `stopped at reserve_check (mode=${mode}, submitAllowed=${this.submitAllowed()}, total=${total})`);
    }

    // 4) 確定（ここから先は送信済み扱い）
    try {
      await this.clickAndWait(page, "上記の内容で予約を確定する");
    } catch (e) {
      throw new ProviderError("UNCERTAIN_SUBMISSION", (e as Error).message, true);
    }
    await this.captureEvidence("complete").catch(() => undefined);
    const confirmed = await this.findExistingReservation(req).catch(() => null);
    if (!confirmed) throw new ProviderError("UNCERTAIN_SUBMISSION", "submitted but the reservation was not found in /user", true);
    return confirmed;
  }

  /** 予約一覧（/user）で、候補のどれかと完全に一致する予約を探す（同日に別バンドの予約があっても誤検知しない） */
  async findExistingReservation(req: ReservationRequest): Promise<ReservationResult | null> {
    const f = facilityOf(req.facility);
    const page = await this.sessions.getPage();
    await this.goto(page, `${BASE}/user`);
    if (!(await this.loggedIn(page))) throw new ProviderError("SESSION_EXPIRED", "not logged in");
    const texts = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href*="reservation_cancel/"]')).map((a) => {
        let box: Element | null = a;
        for (let i = 0; i < 6 && box; i++) {
          box = box.parentElement;
          if (box && /予約番号/.test(box.textContent ?? "")) break;
        }
        return (box?.textContent ?? "").replace(/\s+/g, " ").slice(0, 500);
      }),
    );
    const cands = candidatesFor(req, this);
    for (const t of texts) {
      const r = parseUserReservation(t);
      if (!r || !r.shopName.startsWith(f.name.slice(0, 6))) continue;
      const hit = cands.find((c) => c.spaceKey === r.room && c.start.toMillis() === r.start.toMillis() && c.end.toMillis() === r.end.toMillis());
      if (!hit) continue;
      return { externalReservationId: r.reservationNo, spaceKey: r.room, start: r.start, end: r.end, price: r.price, finalUrl: safeUrl(page.url()) ?? "" };
    }
    return null;
  }

  async captureEvidence(label: string): Promise<Evidence> {
    const page = await this.sessions.getPage();
    const now = DateTime.now().setZone(TZ);
    const dir = join(this.evidenceDir, now.toFormat("yyyy-MM-dd"));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `${now.toFormat("HHmmss.SSS")}-studiol-${label}.png`);
    await page.screenshot({ path, fullPage: true, mask: [page.locator('input[type="password"]'), page.locator('input[type="email"]')] });
    return { label, screenshotPath: path, url: safeUrl(page.url()), capturedAt: now };
  }

  async close(): Promise<void> {
    await this.sessions.close();
  }
}
