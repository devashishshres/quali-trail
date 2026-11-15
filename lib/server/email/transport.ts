import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Rendered } from "./templates";

export const OUTBOX_PATH = ".signoff-outbox/outbox.jsonl";

export class RetryableSendError extends Error {}
export class FatalSendError extends Error {}

export interface OutboxMeta {
  kind: string;
  workerId?: string;
  relatedId?: string;
}

/** Mock delivery: append to a local, git-ignored file readable only by someone with access to this machine. */
export async function sendMockMessage(to: string, r: Rendered, meta: OutboxMeta, path = OUTBOX_PATH): Promise<string> {
  const messageId = `mock_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify({ messageId, simulated: true, at: new Date().toISOString(), to, subject: r.subject, text: r.text, meta }) + "\n", { mode: 0o600 });
  return messageId;
}

/** One HTTP attempt to Resend. Throws Retryable for network/429/5xx, Fatal otherwise. Never echoes the response body. */
export async function sendResendOnce(
  to: string,
  r: Rendered,
  idempotencyKey: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  let res: Response;
  try {
    res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ from: env.RESEND_FROM, to: [to], subject: r.subject, text: r.text, html: r.html }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new RetryableSendError("network error");
  }
  if (res.status === 429 || res.status >= 500) throw new RetryableSendError(`provider status ${res.status}`);
  if (!res.ok) throw new FatalSendError(`provider status ${res.status}`);
  const body = (await res.json().catch(() => null)) as { id?: string } | null;
  if (!body?.id) throw new FatalSendError("provider returned no message id");
  return body.id;
}

/** Up to `attempts` tries with short backoff, only for retryable failures. */
export async function withRetries<T>(fn: () => Promise<T>, attempts = 3, delays = [250, 750], sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!(e instanceof RetryableSendError) || i === attempts - 1) break;
      await sleep(delays[i] ?? delays.at(-1) ?? 0);
    }
  }
  throw last;
}
