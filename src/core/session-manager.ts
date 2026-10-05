/**
 * ブラウザとセッション（Playwright storageState）の管理。
 * storageState は認証情報相当として扱う:
 *   - 保存先ディレクトリ 0700・ファイル 0600
 *   - STATE_ENCRYPTION_KEY（base64 32byte）があれば AES-256-GCM で暗号化して保存
 *   - ログ・通知・スクリーンショットへ内容を出さない
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

function key(): Buffer | null {
  const k = process.env.STATE_ENCRYPTION_KEY;
  if (!k) return null;
  const b = Buffer.from(k, "base64");
  if (b.length !== 32) throw new Error("STATE_ENCRYPTION_KEY must be 32 bytes (base64)");
  return b;
}

export function encryptState(plain: string, k: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", k, iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return JSON.stringify({ v: 1, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: enc.toString("base64") });
}

export function decryptState(blob: string, k: Buffer): string {
  const o = JSON.parse(blob) as { v: number; iv: string; tag: string; data: string };
  const d = createDecipheriv("aes-256-gcm", k, Buffer.from(o.iv, "base64"));
  d.setAuthTag(Buffer.from(o.tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(o.data, "base64")), d.final()]).toString("utf8");
}

export class SessionManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  constructor(
    private readonly provider: string,
    private readonly stateDir: string,
  ) {}

  private get statePath(): string {
    return join(this.stateDir, `${this.provider}.state${key() ? ".enc" : ""}.json`);
  }

  private loadState(): StorageState | undefined {
    if (!existsSync(this.statePath)) return undefined;
    const raw = readFileSync(this.statePath, "utf8");
    const k = key();
    return JSON.parse(k ? decryptState(raw, k) : raw) as StorageState;
  }

  async saveState(): Promise<void> {
    if (!this.context) return;
    const json = JSON.stringify(await this.context.storageState());
    const k = key();
    mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 });
    chmodSync(dirname(this.statePath), 0o700);
    writeFileSync(this.statePath, k ? encryptState(json, k) : json, { mode: 0o600 });
    chmodSync(this.statePath, 0o600);
  }

  async getPage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    if (!this.browser) {
      this.browser = await chromium.launch({
        headless: process.env.HEADED !== "1",
        executablePath: process.env.CHROMIUM_PATH || undefined,
      });
    }
    if (!this.context) {
      this.context = await this.browser.newContext({
        storageState: this.loadState(),
        locale: "ja-JP",
        timezoneId: "Asia/Tokyo",
        viewport: { width: 1280, height: 900 },
      });
      this.context.setDefaultTimeout(15_000);
      this.context.setDefaultNavigationTimeout(20_000);
    }
    this.page = await this.context.newPage();
    return this.page;
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
    this.context = null;
    this.page = null;
  }
}
