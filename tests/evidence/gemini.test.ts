import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const provider = vi.hoisted(() => ({ generate: vi.fn(), options: vi.fn() }));
vi.mock("@google/genai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@google/genai")>();
  return { ...actual, GoogleGenAI: class {
    constructor(options: unknown) { provider.options(options); }
    models = { generateContent: provider.generate };
  } };
});
import { extractFromPdf, extractFromText, ExtractionError } from "@/lib/server/extraction/gemini";

const valid = JSON.stringify({ type: "checklist", title: "Fictional heat-pump commissioning", date: null, issuer: null, structuredData: { activities: ["Checked airflow"] }, uncertainFields: [] });
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("GEMINI_API_KEY", "test-key-not-a-credential");
  vi.stubEnv("GEMINI_MODEL", "primary");
  vi.stubEnv("GEMINI_FALLBACK_MODELS", "backup");
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

it("sends the same PDF, prompt and structured schema to the backup after a timeout", async () => {
  vi.useFakeTimers();
  provider.generate.mockImplementationOnce(() => new Promise(() => {})).mockResolvedValueOnce({ text: valid });
  const result = extractFromPdf(new TextEncoder().encode("%PDF-1.4 fictional test"));
  await vi.advanceTimersByTimeAsync(15_000);
  await expect(result).resolves.toMatchObject({ type: "checklist", title: "Fictional heat-pump commissioning" });
  const [primary, backup] = provider.generate.mock.calls.map(([args]) => args);
  expect(primary.model).toBe("primary"); expect(backup.model).toBe("backup");
  expect(backup.contents).toEqual(primary.contents);
  expect(backup.config.responseSchema).toBe(primary.config.responseSchema);
  expect(backup.config.systemInstruction).toBe(primary.config.systemInstruction);
  expect(primary.config.abortSignal.aborted).toBe(true);
  expect(provider.options.mock.calls[0][0].httpOptions.retryOptions.attempts).toBe(1);
});

it("also switches models for text extraction and retains output normalization", async () => {
  provider.generate.mockRejectedValueOnce({ name: "AbortError" }).mockResolvedValueOnce({ text: valid });
  const result = await extractFromText("Fictional heat-pump commissioning record: checked airflow.");
  expect(result.structuredData.activities).toEqual(["Checked airflow"]);
  expect(result.structuredData.expirationDate).toBeNull();
  expect(provider.generate.mock.calls.map(([args]) => args.model)).toEqual(["primary", "backup"]);
});

it("does not retry malformed model output on another model", async () => {
  provider.generate.mockResolvedValue({ text: "invalid JSON" });
  await expect(extractFromText("A fictional record for testing.")).rejects.toBeInstanceOf(ExtractionError);
  expect(provider.generate).toHaveBeenCalledTimes(1);
});

it("returns the sanitized manual-review error when all models time out", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
  provider.generate.mockImplementation(() => new Promise(() => {}));
  const rejected = expect(extractFromText("Fictional note.")).rejects.toThrow("Gemini is busy or not responding right now.");
  await vi.advanceTimersByTimeAsync(30_000);
  await rejected;
  expect(provider.generate).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
  vi.restoreAllMocks();
});
