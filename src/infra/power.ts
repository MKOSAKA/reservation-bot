/**
 * 停止運用（常駐しない）のための電源管理。
 *
 * - 起動: EventBridge Scheduler の1回限りスケジュールで ec2:StartInstances を呼ぶ
 *   T-24h と T0 の各フェーズの WAKE_LEAD 前に起動し、T0 側は WAKE_RETRY 前にもう一度起動を試みる（起動済みなら無害）
 * - 停止: デーモンが「近い予定なし・実行中なし・起動から一定時間経過・keepalive ファイルなし」を確認して
 *   ec2:StopInstances（IAM で自インスタンスのタグ Project=reservation-bot に限定）
 *
 * EventBridge Scheduler の at() は Asia/Tokyo 指定で登録する。完了後は自動削除（ActionAfterCompletion=DELETE）。
 */
import { existsSync } from "node:fs";
import { EC2Client, StopInstancesCommand } from "@aws-sdk/client-ec2";
import { CreateScheduleCommand, ConflictException, DeleteScheduleCommand, ResourceNotFoundException, SchedulerClient } from "@aws-sdk/client-scheduler";
import { DateTime } from "luxon";
import type { Logger } from "pino";
import { TZ } from "../core/types.js";
import type { Phase } from "../storage/db.js";

export const WAKE_LEAD_MIN = 60;
export const WAKE_RETRY_MIN = 30;
/** これより先に予定がなければ停止してよい */
export const IDLE_HORIZON_MIN = 75;
/** 起動直後に手作業する余地 */
export const MIN_UPTIME_MIN = 20;

export interface WakeTime {
  name: string;
  at: DateTime;
}

export function planWakeTimes(requestId: string, phases: { phase: Phase; dueAt: DateTime }[], now: DateTime): WakeTime[] {
  const out: WakeTime[] = [];
  for (const p of phases) {
    if (p.phase === "preflight_10m") continue; // release の起動で賄う
    const tag = p.phase === "release" ? "rel" : "pf24";
    out.push({ name: `rb-${requestId}-${tag}`, at: p.dueAt.minus({ minutes: WAKE_LEAD_MIN }) });
    if (p.phase === "release") out.push({ name: `rb-${requestId}-${tag}-retry`, at: p.dueAt.minus({ minutes: WAKE_RETRY_MIN }) });
  }
  return out.filter((w) => w.at > now).map((w) => ({ ...w, name: w.name.slice(0, 64) }));
}

export function shouldPowerOff(args: {
  now: DateTime;
  bootedAt: DateTime;
  nextDue: DateTime | null;
  running: boolean;
  keepalive: boolean;
}): boolean {
  if (args.running || args.keepalive) return false;
  if (args.now.diff(args.bootedAt, "minutes").minutes < MIN_UPTIME_MIN) return false;
  if (args.nextDue && args.nextDue.diff(args.now, "minutes").minutes < IDLE_HORIZON_MIN) return false;
  return true;
}

export interface WakeConfig {
  instanceId: string;
  roleArn: string;
  group: string;
}

export function wakeConfigFromEnv(env: NodeJS.ProcessEnv): WakeConfig | null {
  if (!env.WAKE_INSTANCE_ID || !env.WAKE_ROLE_ARN) return null;
  return { instanceId: env.WAKE_INSTANCE_ID, roleArn: env.WAKE_ROLE_ARN, group: env.WAKE_SCHEDULE_GROUP ?? "reservation-bot" };
}

export async function registerWakeSchedules(cfg: WakeConfig, wakes: WakeTime[], log: Logger): Promise<void> {
  const client = new SchedulerClient({ region: process.env.AWS_REGION ?? "ap-northeast-1" });
  for (const w of wakes) {
    try {
      await client.send(
        new CreateScheduleCommand({
          Name: w.name,
          GroupName: cfg.group,
          ScheduleExpression: `at(${w.at.setZone(TZ).toFormat("yyyy-MM-dd'T'HH:mm:ss")})`,
          ScheduleExpressionTimezone: TZ,
          FlexibleTimeWindow: { Mode: "OFF" },
          ActionAfterCompletion: "DELETE",
          Target: {
            Arn: "arn:aws:scheduler:::aws-sdk:ec2:startInstances",
            RoleArn: cfg.roleArn,
            Input: JSON.stringify({ InstanceIds: [cfg.instanceId] }),
            RetryPolicy: { MaximumRetryAttempts: 5, MaximumEventAgeInSeconds: 600 },
          },
        }),
      );
      log.info({ name: w.name, at: w.at.toISO() }, "wake schedule registered");
    } catch (e) {
      if (e instanceof ConflictException) {
        log.info({ name: w.name }, "wake schedule already exists");
        continue;
      }
      throw e;
    }
  }
}

/** リクエストの起動予定（rb-<id>-*）を削除する。存在しないものは無視 */
export async function deleteWakeSchedules(cfg: WakeConfig, requestId: string, log: Logger): Promise<string[]> {
  const client = new SchedulerClient({ region: process.env.AWS_REGION ?? "ap-northeast-1" });
  const deleted: string[] = [];
  for (const tag of ["pf24", "rel", "rel-retry"]) {
    const name = `rb-${requestId}-${tag}`.slice(0, 64);
    try {
      await client.send(new DeleteScheduleCommand({ Name: name, GroupName: cfg.group }));
      deleted.push(name);
      log.info({ name }, "wake schedule deleted");
    } catch (e) {
      if (e instanceof ResourceNotFoundException) continue;
      throw e;
    }
  }
  return deleted;
}

export function keepaliveExists(dataDir: string): boolean {
  return existsSync(`${dataDir}/keepalive`);
}

/** 自インスタンスを停止する（systemd の NoNewPrivileges を保ったまま sudo を使わずに済ませる） */
export async function powerOff(cfg: WakeConfig, log: Logger): Promise<void> {
  log.warn("idle: stopping instance");
  const ec2 = new EC2Client({ region: process.env.AWS_REGION ?? "ap-northeast-1" });
  await ec2.send(new StopInstancesCommand({ InstanceIds: [cfg.instanceId] }));
}
