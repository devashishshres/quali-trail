import { afterEach, describe, expect, it, vi } from "vitest";
import { extractionModels, ModelTimeoutError, withModelFallback } from "@/lib/server/extraction/model-fallback";

afterEach(() => vi.useRealTimers());

describe("extraction model configuration", () => {
  it("uses ordered default backups after the configured primary", () => {
    expect(extractionModels()).toEqual(["gemini-3.5-flash-lite", "gemini-3.5-flash", "gemini-3.1-flash-lite"]);
    expect(extractionModels("custom-primary")).toEqual(["custom-primary", "gemini-3.5-flash", "gemini-3.1-flash-lite"]);
  });
  it("normalizes, deduplicates and caps configured models", () => {
    expect(extractionModels(" models/primary ", "primary, backup, , models/backup, third, fourth")).toEqual(["primary", "backup", "third"]);
  });
  it("allows an empty override to disable backups", () => {
    expect(extractionModels("primary", "")).toEqual(["primary"]);
  });
});

describe("model failover", () => {
  it("returns immediately on success without calling backups", async () => {
    const invoke = vi.fn().mockResolvedValue("valid extraction");
    await expect(withModelFallback(["primary", "backup"], invoke)).resolves.toBe("valid extraction");
    expect(invoke.mock.calls.map(([model]) => model)).toEqual(["primary"]);
  });

  it("aborts a hung primary and uses the next model at the deadline", async () => {
    vi.useFakeTimers();
    let primarySignal: AbortSignal | undefined;
    const invoke = vi.fn((model: string, signal: AbortSignal) => {
      if (model === "primary") { primarySignal = signal; return new Promise<string>(() => {}); }
      return Promise.resolve("backup extraction");
    });
    const result = withModelFallback(["primary", "backup"], invoke);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(invoke).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe("backup extraction");
    expect(primarySignal?.aborted).toBe(true);
    expect(invoke.mock.calls.map(([model]) => model)).toEqual(["primary", "backup"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["AbortError", "TimeoutError", "RequestTimeoutError"])("handles an SDK %s without an HTTP status", async (name) => {
    const invoke = vi.fn().mockRejectedValueOnce(Object.assign(new Error("request failed"), { name })).mockResolvedValueOnce("ok");
    await expect(withModelFallback(["primary", "backup"], invoke)).resolves.toBe("ok");
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it.each([404, 408, 429, 500, 502, 503, 504])("tries a backup for model/provider status %s", async (status) => {
    const invoke = vi.fn().mockRejectedValueOnce({ status }).mockResolvedValueOnce("ok");
    await expect(withModelFallback(["primary", "backup"], invoke)).resolves.toBe("ok");
  });

  it.each([400, 401, 403])("does not hop models for invalid input or access errors (%s)", async (status) => {
    const failure = { status };
    const invoke = vi.fn().mockRejectedValue(failure);
    await expect(withModelFallback(["primary", "backup"], invoke)).rejects.toBe(failure);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("recognizes a connection timeout wrapped by the fetch/SDK error", async () => {
    const invoke = vi.fn().mockRejectedValueOnce({ name: "TypeError", cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }).mockResolvedValueOnce("ok");
    await expect(withModelFallback(["primary", "backup"], invoke)).resolves.toBe("ok");
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("does not mask an explicit access error with a nested timeout", async () => {
    const failure = { status: 403, cause: { name: "TimeoutError" } };
    const invoke = vi.fn().mockRejectedValue(failure);
    await expect(withModelFallback(["primary", "backup"], invoke)).rejects.toBe(failure);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("stops after three hung models and clears all timers", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const invoke = vi.fn((_model: string, signal: AbortSignal) => {
      signals.push(signal); return new Promise<string>(() => {});
    });
    const result = withModelFallback(["primary", "backup", "third", "fourth"], invoke);
    const rejected = expect(result).rejects.toBeInstanceOf(ModelTimeoutError);
    await vi.advanceTimersByTimeAsync(45_000);
    await rejected;
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores late primary completion after the backup succeeds", async () => {
    vi.useFakeTimers();
    let finishPrimary!: (value: string) => void;
    const invoke = vi.fn((model: string) => model === "primary"
      ? new Promise<string>((resolve) => { finishPrimary = resolve; })
      : Promise.resolve("backup"));
    const result = withModelFallback(["primary", "backup"], invoke);
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(result).resolves.toBe("backup");
    finishPrimary("late primary");
    await expect(result).resolves.toBe("backup");
  });

  it("starts each independent extraction with the configured primary", async () => {
    const invoke = vi.fn().mockRejectedValueOnce({ status: 503 }).mockResolvedValue("ok");
    await withModelFallback(["primary", "backup"], invoke);
    await withModelFallback(["primary", "backup"], invoke);
    expect(invoke.mock.calls.map(([model]) => model)).toEqual(["primary", "backup", "primary"]);
  });
});
