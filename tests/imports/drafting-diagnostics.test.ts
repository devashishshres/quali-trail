/**
 * Regression for the first production import: drafting ended after ONE ~15 s attempt with a 504 and no fallback.
 * The deployed code gives every attempt a fixed 15 s and, when the configured chain has one model (an empty or
 * duplicate GEMINI_FALLBACK_MODELS), stops there even with ~95 s of budget left. Logs only carried the final
 * status, so our own deadline and a provider 504 looked the same. Fictional listing text; no provider calls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const provider = vi.hoisted(() => ({ generate: vi.fn(), options: vi.fn() }));
vi.mock("@google/genai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@google/genai")>();
  return { ...actual, GoogleGenAI: class {
    constructor(options: unknown) { provider.options(options); }
    models = { generateContent: provider.generate };
  } };
});
import { attemptOutcome, ModelTimeoutError, modelFailureLog, planModelAttempts, withModelFallback, type ModelAttempt } from "@/lib/server/extraction/model-fallback";
import { proposeWithGemini } from "@/lib/server/imports/structure";

const LISTING = "FICTIONAL listing. Requirements: EPA 608 certification required. Contact jane@example.com";
const KEY = "test-key-not-a-credential";
const proposal = JSON.stringify({ title: "Fictional HVAC Installer", employer: null, location: null, requirements: [{ text: "EPA 608 certification required", category: null }] });
let errors: unknown[][] = [];
beforeEach(() => {
  vi.resetAllMocks();
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a));
  vi.stubEnv("GEMINI_API_KEY", KEY);
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("attempt planning shares the caller's budget", () => {
  it.each([
    [["only"], 95_000, 1, 30_000], // the production shape: one model gets 30 s, not 15 s
    [["a", "b", "c"], 95_000, 3, 30_000],
    [["a", "b", "c"], 50_000, 3, 16_666],
    [["a", "b", "c"], 40_000, 2, 20_000],
    [["a", "a"], 95_000, 1, 30_000], // duplicates collapse to one model
    [["a", "b"], 14_999, 0, 15_000],
  ])("%j within %d ms → %d attempt(s) of %d ms", (models, budget, n, ms) => {
    const plan = planModelAttempts(models, budget);
    expect(plan.models).toHaveLength(n);
    if (n) expect(plan.attemptMs).toBe(ms);
    expect(n * plan.attemptMs).toBeLessThanOrEqual(Math.max(budget, 15_000));
  });
});

describe("attempt diagnostics", () => {
  it("separates our deadline from a provider 504 and names each category", () => {
    expect(attemptOutcome(new ModelTimeoutError())).toBe("deadline");
    expect(attemptOutcome({ status: 504 })).toBe("provider_timeout");
    expect(attemptOutcome({ name: "TimeoutError" })).toBe("provider_timeout");
    expect(attemptOutcome({ status: 429 })).toBe("rate_limited");
    expect(attemptOutcome({ status: 404 })).toBe("model_not_found");
    expect(attemptOutcome({ status: 503 })).toBe("unavailable");
    expect(attemptOutcome({ status: 403 })).toBe("auth");
    expect(attemptOutcome({ status: 400 })).toBe("bad_request");
    expect(attemptOutcome(new Error("x"))).toBe("other");
  });

  it("records one entry per attempt: model, outcome, status and duration", async () => {
    vi.useFakeTimers();
    const log: ModelAttempt[] = [];
    const invoke = vi.fn((model: string) => (model === "a" ? new Promise<string>(() => {}) : model === "b" ? Promise.reject({ status: 429 }) : Promise.reject({ status: 404 })));
    const result = withModelFallback(["a", "b", "c"], invoke, 15_000, log).catch((e) => e);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await result).toEqual({ status: 404 });
    expect(log).toEqual([
      { model: "a", outcome: "deadline", status: 504, ms: 15_000 },
      { model: "b", outcome: "rate_limited", status: 429, ms: 0 },
      { model: "c", outcome: "model_not_found", status: 404, ms: 0 },
    ]);
  });
});

describe("import drafting (production failure shape)", () => {
  it("a one-model chain now gets the shared budget: a 20 s response succeeds instead of failing at 15 s", async () => {
    vi.useFakeTimers();
    vi.stubEnv("GEMINI_MODEL", "only-model");
    vi.stubEnv("GEMINI_FALLBACK_MODELS", "");
    provider.generate.mockImplementationOnce(() => new Promise((r) => setTimeout(() => r({ text: proposal }), 20_000)));
    const p = proposeWithGemini(LISTING, 95_000);
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(p).resolves.toMatchObject({ title: "Fictional HVAC Installer" });
    expect(provider.generate).toHaveBeenCalledTimes(1);
    expect(provider.options.mock.calls[0][0].httpOptions).toMatchObject({ timeout: 31_000, retryOptions: { attempts: 1 } });
  });

  it("a hung one-model chain fails as busy after ONE attempt, and the log says why — without listing text or key", async () => {
    vi.useFakeTimers();
    vi.stubEnv("GEMINI_MODEL", "only-model");
    vi.stubEnv("GEMINI_FALLBACK_MODELS", "");
    provider.generate.mockImplementation(() => new Promise(() => {}));
    const p = proposeWithGemini(LISTING, 95_000).catch((e) => e);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await p).toMatchObject({ code: "draft_model_busy" });
    expect(provider.generate).toHaveBeenCalledTimes(1);
    const [msg, fields] = errors.find(([m]) => m === "import drafting failed")!;
    expect(msg).toBe("import drafting failed");
    expect(fields).toEqual({
      status: 504,
      attemptMs: 30_000,
      configuredModels: ["only-model"],
      attempts: [{ model: "only-model", outcome: "deadline", status: 504, ms: 30_000 }],
      totalMs: 30_000,
      finalStatus: 504,
      finalOutcome: "deadline",
    });
    const logged = JSON.stringify(errors);
    expect(logged).not.toContain("EPA 608");
    expect(logged).not.toContain("jane@example.com");
    expect(logged).not.toContain(KEY);
  });

  it("with the default chain, a hung primary falls through to the backup within the budget", async () => {
    vi.useFakeTimers();
    provider.generate.mockImplementationOnce(() => new Promise(() => {})).mockResolvedValueOnce({ text: proposal });
    const p = proposeWithGemini(LISTING, 95_000);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(p).resolves.toMatchObject({ title: "Fictional HVAC Installer" });
    expect(provider.generate.mock.calls.map(([a]) => a.model)).toEqual(["gemini-3.5-flash-lite", "gemini-3.5-flash"]);
  });

  it("the failure log helper never includes anything but names, categories, statuses and durations", () => {
    const f = modelFailureLog(["a"], [{ model: "a", outcome: "unavailable", status: 503, ms: 120 }], { status: 503, message: "secret prompt text" });
    expect(f).toEqual({ configuredModels: ["a"], attempts: [{ model: "a", outcome: "unavailable", status: 503, ms: 120 }], totalMs: 120, finalStatus: 503, finalOutcome: "unavailable" });
  });
});
