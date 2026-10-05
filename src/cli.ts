/**
 * CLI
 *   add <request.yaml>          予約リクエストを登録し、フェーズ（T-24h/T-10m/T0）を計画する
 *   cancel <id>                 リクエストを取り消し、起動予定を削除
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
import { describeResolved, resolveRequestFile } from "./config/resolve.js";
import { Scheduler, formatNextJobs, planPhases } from "./core/scheduler.js";
import { TZ, type Mode, type ReservationRequest } from "./core/types.js";
import { deleteWakeSchedules, keepaliveExists, planWakeTimes, powerOff, registerWakeSchedules, shouldPowerOff, wakeConfigFromEnv } from "./infra/power.js";

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
  if (cmd === "validate") {
    // DB・秘密情報なしで検証する（CI / GitHub Actions 用）
    const files = process.argv.slice(3);
    if (files.length === 0) throw new Error("usage: validate <request.yaml...>");
    for (const f of files) console.log(describeResolved(resolveRequestFile(f)));
    return;
  }
  const app = buildApp();
  const { store, providers, log } = app;

  switch (cmd) {
    case "add": {
      if (!target) throw new Error("usage: add <request.yaml>");
      const { req, releaseAt, warnings } = resolveRequestFile(target);
      store.upsertRequest(req, releaseAt);
      const phases = planPhases(releaseAt);
      store.ensurePhases(req.id, phases);
      const lines = [describeResolved({ req, releaseAt, warnings })];
      const wake = wakeConfigFromEnv(process.env);
      if (wake) {
        const wakes = planWakeTimes(req.id, phases, DateTime.now().setZone(TZ));
        await registerWakeSchedules(wake, wakes, log);
        for (const w of wakes) lines.push(`  起動予定: ${w.at.toFormat("yyyy-MM-dd HH:mm")}`);
      } else {
        lines.push("  (WAKE_INSTANCE_ID 未設定: 起動予定は登録しない)");
      }
      console.log(lines.join("\n"));
      console.log(formatNextJobs(store));
      await app.notifier.send("info", `📝 予約リクエストを登録しました\n${lines.join("\n")}`);
      break;
    }
    case "wake-at": {
      // 観測・手作業のための臨時起動: wake-at 2026-10-11T23:30 <name>
      const wake = wakeConfigFromEnv(process.env);
      if (!wake || !target) throw new Error("usage: wake-at <yyyy-MM-ddTHH:mm> [name]  (WAKE_INSTANCE_ID 必須)");
      const at = DateTime.fromISO(target, { zone: TZ });
      if (!at.isValid) throw new Error("invalid datetime");
      const name = process.argv[4] ?? `rb-manual-${at.toFormat("yyyyMMdd-HHmm")}`;
      await registerWakeSchedules(wake, [{ name, at }], log);
      console.log(`wake ${at.toFormat("yyyy-MM-dd HH:mm")} ${name}`);
      break;
    }
    case "cancel": {
      // リクエストを取り消し、起動予定も削除する（実行中・完了済みは取り消さない）
      if (!target) throw new Error("usage: cancel <request-id>");
      const ok = store.transition(target, ["draft", "scheduled", "preflight_ok", "failed", "manual_intervention_required"], "cancelled");
      console.log(ok ? `cancelled ${target}` : `not cancelled (status: ${store.getRequest(target)?.status ?? "not found"})`);
      const wake = wakeConfigFromEnv(process.env);
      if (ok && wake) console.log(`deleted schedules: ${(await deleteWakeSchedules(wake, target, log)).join(", ") || "なし"}`);
      if (ok) await app.notifier.send("info", `🗑 予約リクエストを取り消しました: ${target}`);
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
    case "session-check": {
      // ログイン状態の確認。切れていれば1回だけログインする（ループしない）
      const name = target ?? "labola";
      const p = providers.get(name);
      if (!p) throw new Error(`unknown provider ${name}`);
      let s = await p.validateSession().catch((e) => ({ valid: false, detail: (e as Error).message }));
      if (!s.valid) {
        console.log(`session invalid (${s.detail}); logging in once`);
        await p.authenticate().catch((e) => console.log(`login failed: ${(e as { category?: string }).category ?? ""} ${(e as Error).message}`));
        s = await p.validateSession().catch((e) => ({ valid: false, detail: (e as Error).message }));
      }
      store.setSession(name, s.valid ? "valid" : "invalid", s.detail);
      console.log(`session: ${s.valid ? "valid" : "INVALID"} (${s.detail})`);
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
      const bootedAt = DateTime.now().setZone(TZ);
      const next = store.nextDue();
      await app.notifier.send("info", `🟢 起動しました ${bootedAt.toFormat("MM/dd HH:mm")}\n次の予定: ${next ? next.toFormat("MM/dd HH:mm") : "なし"}`);
      const wakeCfg = wakeConfigFromEnv(process.env);
      if (process.env.AUTO_POWEROFF === "1" && wakeCfg) {
        let stopping = false;
        setInterval(() => {
          const now = DateTime.now().setZone(TZ);
          if (!stopping && shouldPowerOff({ now, bootedAt, nextDue: store.nextDue(), running: scheduler.isBusy(), keepalive: keepaliveExists(app.dataDir) })) {
            void app.notifier.send("info", `⚪ 予定がないため停止します（次: ${store.nextDue()?.toFormat("MM/dd HH:mm") ?? "なし"}）`).then(() => {
              stopping = true;
              return powerOff(wakeCfg, log);
            }).catch((e) => log.error({ err: (e as Error).message }, "power off failed"));
          }
        }, 60_000);
      }
      return; // 常駐
    }
    default:
      console.log("commands: validate | add | cancel | wake-at | session-check | next-jobs | status | run | preflight | daemon");
  }
  store.close();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
