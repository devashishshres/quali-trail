/** Bounded failover for extraction. No credentials, document text or SDK state. */
export const MODEL_TIMEOUT_MS = 15_000; // minimum (and default) time one model attempt gets
export const MAX_ATTEMPT_MS = 30_000; // cap for one attempt when a caller's budget allows more
export const MAX_MODEL_ATTEMPTS = 3;
const DEFAULT_PRIMARY_MODEL = "gemini-3.5-flash-lite";
const DEFAULT_FALLBACKS = ["gemini-3.5-flash", "gemini-3.1-flash-lite"];

/** Comma-separated overrides; an explicitly empty override disables backups. */
export function extractionModels(primary?: string, configuredFallbacks?: string): string[] {
  const fallbacks = configuredFallbacks === undefined ? DEFAULT_FALLBACKS : configuredFallbacks.split(",");
  const names = [primary?.trim() || DEFAULT_PRIMARY_MODEL, ...fallbacks].map((name) => name.trim().replace(/^models\//, "")).filter(Boolean);
  return [...new Set(names)].slice(0, MAX_MODEL_ATTEMPTS);
}

export class ModelTimeoutError extends Error {
  readonly status = 504;
  constructor() {
    super("Extraction model deadline exceeded.");
    this.name = "ModelTimeoutError";
  }
}

export function providerStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const e = error as { status?: unknown; statusCode?: unknown };
  const value = e.status ?? e.statusCode;
  return typeof value === "number" ? value : undefined;
}

/** Auth, permission, bad input and malformed model output are not outages. */
function hasTimeoutCause(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== "object" || depth > 3) return false;
  const e = error as { name?: string; code?: string; cause?: unknown };
  if (["AbortError", "TimeoutError", "RequestTimeoutError", "ConnectTimeoutError", "HeadersTimeoutError", "BodyTimeoutError"].includes(e.name ?? "")) return true;
  if (["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"].includes(e.code ?? "")) return true;
  return hasTimeoutCause(e.cause, depth + 1);
}

export function canTryAnotherModel(error: unknown): boolean {
  const status = providerStatus(error);
  if (status !== undefined) return [404, 408, 429, 500, 502, 503, 504].includes(status);
  return hasTimeoutCause(error);
}

async function withDeadline<T>(invoke: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => invoke(controller.signal)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new ModelTimeoutError();
          controller.abort(error);
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What happened to one model attempt, for logs. Model names, an HTTP status, a category and a duration only:
 * never prompts, listing text, evidence, responses or keys.
 *   deadline          our own per-attempt deadline fired (ModelTimeoutError; reported as 504 by providerStatus)
 *   provider_timeout  the provider or network reported a timeout (HTTP 408/504 or a timeout error)
 */
export type AttemptOutcome = "ok" | "deadline" | "provider_timeout" | "rate_limited" | "unavailable" | "model_not_found" | "auth" | "bad_request" | "other";
export interface ModelAttempt {
  model: string;
  outcome: AttemptOutcome;
  status: number | null;
  ms: number;
}

export function attemptOutcome(error: unknown): AttemptOutcome {
  if (error instanceof ModelTimeoutError) return "deadline";
  const status = providerStatus(error);
  if (status === 408 || status === 504) return "provider_timeout";
  if (status === 429) return "rate_limited";
  if (status === 404) return "model_not_found";
  if (status === 401 || status === 403) return "auth";
  if (status === 400) return "bad_request";
  if (status !== undefined && status >= 500) return "unavailable";
  if (status === undefined && hasTimeoutCause(error)) return "provider_timeout";
  return "other";
}

/**
 * How many of the configured models to try within `budgetMs`, and how long each attempt may take. Every attempt
 * gets at least MODEL_TIMEOUT_MS; unused budget is shared out (up to MAX_ATTEMPT_MS each), so a chain with one
 * model is not limited to 15 s when the caller has far more time. Never plans past the budget.
 */
export function planModelAttempts(models: readonly string[], budgetMs: number): { models: string[]; attemptMs: number } {
  const unique = [...new Set(models)].slice(0, MAX_MODEL_ATTEMPTS);
  const n = Math.min(unique.length, Math.floor(budgetMs / MODEL_TIMEOUT_MS));
  if (n < 1) return { models: [], attemptMs: MODEL_TIMEOUT_MS };
  return { models: unique.slice(0, n), attemptMs: Math.max(MODEL_TIMEOUT_MS, Math.min(MAX_ATTEMPT_MS, Math.floor(budgetMs / n))) };
}

/** Safe log fields for a model step that ended in failure. */
export function modelFailureLog(configured: readonly string[], attempts: readonly ModelAttempt[], error: unknown) {
  return {
    configuredModels: [...configured],
    attempts: attempts.map((a) => ({ ...a })),
    totalMs: attempts.reduce((sum, a) => sum + a.ms, 0),
    finalStatus: providerStatus(error) ?? null,
    finalOutcome: attemptOutcome(error),
  };
}

/**
 * Each model is attempted once, in order. Every request starts with the primary. When `log` is given, one entry
 * per attempt is appended to it (model, outcome, status, duration).
 */
export async function withModelFallback<T>(
  models: readonly string[],
  invoke: (model: string, signal: AbortSignal) => Promise<T>,
  timeoutMs = MODEL_TIMEOUT_MS,
  log?: ModelAttempt[],
  now: () => number = Date.now,
): Promise<T> {
  let lastError: unknown = new Error("No extraction model configured.");
  for (const model of [...new Set(models)].slice(0, MAX_MODEL_ATTEMPTS)) {
    const started = now();
    try {
      const result = await withDeadline((signal) => invoke(model, signal), timeoutMs);
      log?.push({ model, outcome: "ok", status: null, ms: now() - started });
      return result;
    } catch (error) {
      log?.push({ model, outcome: attemptOutcome(error), status: providerStatus(error) ?? null, ms: now() - started });
      if (!canTryAnotherModel(error)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}
