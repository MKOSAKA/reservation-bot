/** 依存の組み立て（composition root）。 */
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { createLogger } from "./core/logger.js";
import { notifierFromEnv } from "./core/notification.js";
import { ReservationEngine } from "./core/reservation-engine.js";
import { SessionManager } from "./core/session-manager.js";
import type { ProviderAdapter } from "./core/types.js";
import { LabolaAdapter } from "./providers/labola/adapter.js";
import { Store } from "./storage/db.js";

export function buildApp(env: NodeJS.ProcessEnv = process.env) {
  const dataDir = env.DATA_DIR ?? join(process.cwd(), "data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const log = createLogger();
  const store = new Store(env.DB_PATH ?? join(dataDir, "app.db"));
  const notifier = notifierFromEnv(env, log);
  const evidenceDir = join(dataDir, "evidence");
  const stateDir = join(dataDir, "state");

  const providers = new Map<string, ProviderAdapter>();
  providers.set(
    "labola",
    new LabolaAdapter(new SessionManager("labola", stateDir), evidenceDir, () =>
      env.LABOLA_MEMBER_ID && env.LABOLA_PASSWORD ? { memberId: env.LABOLA_MEMBER_ID, password: env.LABOLA_PASSWORD } : null,
    ),
  );

  const engineFor = (provider: ProviderAdapter) => new ReservationEngine({ store, provider, notifier, log });
  return { log, store, notifier, providers, engineFor, dataDir };
}
