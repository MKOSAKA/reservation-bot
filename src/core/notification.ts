/**
 * 通知。第一候補は LINE Messaging API の push（LINE Notify は2025-03-31で終了済み）。
 * 通知の失敗で予約処理を止めない（例外は握りつぶしてログに残す）。
 */
import type { Logger } from "pino";

export type NotifyKind = "success" | "failure" | "session_expired" | "preflight_failed" | "site_changed" | "manual_intervention" | "info";

export interface Notifier {
  send(kind: NotifyKind, text: string): Promise<void>;
}

export class ConsoleNotifier implements Notifier {
  constructor(private readonly log: Logger) {}
  async send(kind: NotifyKind, text: string): Promise<void> {
    this.log.info({ kind }, `[notify] ${text}`);
  }
}

export class LineNotifier implements Notifier {
  constructor(
    private readonly channelAccessToken: string,
    private readonly to: string,
    private readonly log: Logger,
  ) {}
  async send(kind: NotifyKind, text: string): Promise<void> {
    try {
      const res = await fetch("https://api.line.me/v2/bot/message/push", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.channelAccessToken}` },
        body: JSON.stringify({ to: this.to, messages: [{ type: "text", text: text.slice(0, 4900) }] }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) this.log.error({ kind, status: res.status }, "LINE push failed");
    } catch (e) {
      this.log.error({ kind, err: (e as Error).message }, "LINE push error");
    }
  }
}

export class DiscordNotifier implements Notifier {
  constructor(private readonly webhookUrl: string, private readonly log: Logger) {}
  async send(kind: NotifyKind, text: string): Promise<void> {
    try {
      const res = await fetch(this.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text.slice(0, 1900) }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) this.log.error({ kind, status: res.status }, "Discord webhook failed");
    } catch (e) {
      this.log.error({ kind, err: (e as Error).message }, "Discord webhook error");
    }
  }
}

/** Slack Incoming Webhook（自分宛て通知の第一候補。URL 1つで済み、スマホにpush通知される） */
export class SlackNotifier implements Notifier {
  constructor(private readonly webhookUrl: string, private readonly log: Logger) {}
  async send(kind: NotifyKind, text: string): Promise<void> {
    try {
      const res = await fetch(this.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text.slice(0, 3900) }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) this.log.error({ kind, status: res.status }, "Slack webhook failed");
    } catch (e) {
      this.log.error({ kind, err: (e as Error).message }, "Slack webhook error");
    }
  }
}

export class FanoutNotifier implements Notifier {
  constructor(private readonly targets: Notifier[]) {}
  async send(kind: NotifyKind, text: string): Promise<void> {
    await Promise.all(this.targets.map((t) => t.send(kind, text)));
  }
}

export function notifierFromEnv(env: NodeJS.ProcessEnv, log: Logger): Notifier {
  const targets: Notifier[] = [new ConsoleNotifier(log)];
  if (env.SLACK_WEBHOOK_URL) targets.push(new SlackNotifier(env.SLACK_WEBHOOK_URL, log));
  if (env.LINE_CHANNEL_ACCESS_TOKEN && env.LINE_TO_USER_ID) targets.push(new LineNotifier(env.LINE_CHANNEL_ACCESS_TOKEN, env.LINE_TO_USER_ID, log));
  if (env.DISCORD_WEBHOOK_URL) targets.push(new DiscordNotifier(env.DISCORD_WEBHOOK_URL, log));
  return new FanoutNotifier(targets);
}
