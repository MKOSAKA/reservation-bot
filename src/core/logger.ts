/** ログ。認証情報に当たるキーは常に伏せる。 */
import pino from "pino";

export const REDACT_PATHS = [
  "password",
  "*.password",
  "cookie",
  "*.cookie",
  "cookies",
  "*.cookies",
  "token",
  "*.token",
  "authorization",
  "*.authorization",
  "storageState",
  "*.storageState",
  "headers.cookie",
  "headers.authorization",
];

export function createLogger(name = "reservation-bot") {
  return pino({
    name,
    level: process.env.LOG_LEVEL ?? "info",
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
  });
}

/** URL からクエリ文字列（トークンが乗り得る）を落とす */
export function safeUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return null;
  }
}
