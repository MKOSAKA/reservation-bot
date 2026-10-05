/**
 * CLI
 *   add <request.yaml>          予約リクエストを登録し、フェーズ（T-24h/T-10m/T0）を計画する
 *   next-jobs                   今後のフェーズ一覧
 *   status <id>                 リクエスト状態と試行履歴
 *   run <id> [--mode m]         即時実行（dry-run / assist / auto）
 *   preflight <id>              事前チェックのみ
 *   daemon                      常駐スケジューラ（systemd から起動）
 */
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DateTime } from "luxon";
import { buildApp } from "./app.js";
import { loadRequestFile } from "./config/load.js";
import { policyFor } from "./core/release-policy.js";
import { Scheduler, formatNextJobs, planPhases } from "./core/scheduler.js";
import { TZ, type Mode, type ReservationRequest } from "./core/types.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** 単一インスタンス保証。PID が生きていれば起動しない */
function acquireLock(path: string): () => void {
  if (existsSync(path)) {
    const pid = Number(readFileSync(path, "utf8"));
    try {
      process.kill(pid, 0);
      throw new Error(`daemon already running (pid ${pid})`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
      unlinkSync(path); // stale
    }
  }
  const fd = openSync(path, "wx", 0o600);
  writeFileSync(fd, String(process.pid));
  closeSync(fd);
  return () => {
    try {
      unlinkSync(path);
    } catch {
      /* noop */
    }
  };
}

async function main() {
  const [cmd, target] = process.argv.slice(2);
  const app = buildApp();
  const { store, providers, log } = app;

  switch (cmd) {
    case "add": {
      if (!target) throw new Error("usage: add <request.yaml>");
      const r = loadRequestFile(target);
      const provider = providers.get(r.provider);
      if (!provider) throw new Error(`unknown provider ${r.provider}`);
      const release = r.release ?? provider.defaultReleaseRule(r.facility);
      if (!release) throw new Error("release rule is required");
      const req: ReservationRequest = { ...r, release };
      const releaseAt = policyFor(release).releaseAt(req.targetDate);
      store.upsertRequest(req, releaseAt);
      store.ensurePhases(req.id, planPhases(releaseAt));
      console.log(`registered ${req.id}: release at ${releaseAt.toFormat("yyyy-MM-dd HH:mm:ss ZZZZ")} (mode=${req.mode})`);
      console.log(formatNextJobs(store));
      break;
    }
    case "next-jobs":
      console.log(`now ${DateTime.now().setZone(TZ).toFormat("yyyy-MM-dd HH:mm:ss")} JST`);
      console.log(formatNextJobs(store));
      break;
    case "status": {
      const r = store.getRequest(target!);
      console.log(JSON.stringify(r, null, 2));
      console.table(store.attempts(target!));
      console.log(store.reservationFor(target!));
      break;
    }
    case "run": {
      const r = store.getRequest(target!);
      if (!r) throw new Error("not found");
      const mode = (arg("--mode") as Mode | undefined) ?? "dry-run";
      const outcome = await app.engineFor(providers.get(r.provider)!).run(r.id, mode);
      console.log(JSON.stringify(outcome, null, 2));
      await providers.get(r.provider)!.close();
      break;
    }
    case "preflight": {
      const r = store.getRequest(target!);
      if (!r) throw new Error("not found");
      const p = providers.get(r.provider)!;
      console.log(JSON.stringify(await p.preflight(r), null, 2));
      await p.close();
      break;
    }
    case "daemon": {
      const release = acquireLock(join(app.dataDir, "daemon.pid"));
      const scheduler = new Scheduler({ store, providers, engineFor: app.engineFor, notifier: app.notifier, log });
      const shutdown = async () => {
        scheduler.stop();
        for (const p of providers.values()) await p.close();
        release();
        process.exit(0);
      };
      process.on("SIGTERM", shutdown);
      process.on("SIGINT", shutdown);
      scheduler.start();
      log.info(formatNextJobs(store));
      return; // 常駐
    }
    default:
      console.log("commands: add | next-jobs | status | run | preflight | daemon");
  }
  store.close();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
