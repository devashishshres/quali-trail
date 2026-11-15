/** Bounded failover for extraction. No credentials, document text or SDK state. */
export const MODEL_TIMEOUT_MS = 15_000;
export const MAX_MODEL_ATTEMPTS = 3;
const DEFAULT_FALLBACKS = ["gemini-2.5-flash-lite", "gemini-2.5-flash"];

/** Comma-separated overrides; an explicitly empty override disables backups. */
export function extractionModels(primary: string, configuredFallbacks?: string): string[] {
  const fallbacks = configuredFallbacks === undefined ? DEFAULT_FALLBACKS : configuredFallbacks.split(",");
  const names = [primary, ...fallbacks].map((name) => name.trim().replace(/^models\//, "")).filter(Boolean);
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

/** Each model is attempted once, in order. Every request starts with the primary. */
export async function withModelFallback<T>(
  models: readonly string[],
  invoke: (model: string, signal: AbortSignal) => Promise<T>,
  timeoutMs = MODEL_TIMEOUT_MS,
): Promise<T> {
  let lastError: unknown = new Error("No extraction model configured.");
  for (const model of [...new Set(models)].slice(0, MAX_MODEL_ATTEMPTS)) {
    try {
      return await withDeadline((signal) => invoke(model, signal), timeoutMs);
    } catch (error) {
      if (!canTryAnotherModel(error)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}
