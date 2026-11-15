/** Rate limiting for import and explanations needs SIGNOFF_PEPPER; problems name variables, never values. */
import { describe, expect, it } from "vitest";
import { rateLimitProblems } from "@/lib/server/config";
import { explanationsAvailable, explanationsConfigProblems } from "@/lib/server/explanations/config";
import { importConfigProblems } from "@/lib/server/imports/config";

const PEPPER = "fictional-test-pepper-0123456789abcdef"; // 38 chars, test-only
const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;
const local = { APP_BASE_URL: "http://localhost:3100", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321" };

describe("SIGNOFF_PEPPER is required for rate limiting", () => {
  it.each([
    ["missing", {}, /is not set \(explanation rate limiting needs it\)/],
    ["too short", { SIGNOFF_PEPPER: "short-value" }, /at least 32 characters/],
  ])("explanations: %s pepper is a problem and turns the feature off", (_n, extra, msg) => {
    const p = explanationsConfigProblems(env({ ...local, AI_EXPLANATIONS_ENABLED: "true", AI_EXPLANATIONS_MODE: "stub", ...extra }));
    expect(p.map((x) => x.name)).toEqual(["SIGNOFF_PEPPER"]);
    expect(p[0].problem).toMatch(msg);
    expect(JSON.stringify(p)).not.toContain("short-value");
    expect(explanationsAvailable(env({ ...local, AI_EXPLANATIONS_ENABLED: "true", AI_EXPLANATIONS_MODE: "stub", ...extra }))).toBe(false);
  });

  it("explanations: a long enough pepper (separate local value) is accepted", () => {
    expect(explanationsConfigProblems(env({ ...local, AI_EXPLANATIONS_ENABLED: "true", AI_EXPLANATIONS_MODE: "stub", SIGNOFF_PEPPER: PEPPER }))).toEqual([]);
  });

  it("import: missing pepper is a problem when the feature is on, named for import", () => {
    const p = importConfigProblems(env({ ...local, OPPORTUNITY_IMPORT_ENABLED: "true", TINYFISH_MODE: "stub", GEMINI_API_KEY: "x" }));
    expect(p).toEqual([{ name: "SIGNOFF_PEPPER", problem: "is not set (import rate limiting needs it)" }]);
  });

  it("features that are off do not demand a pepper", () => {
    expect(explanationsConfigProblems(env({}))).toEqual([]);
    expect(importConfigProblems(env({}))).toEqual([]);
  });

  it("the shared check never echoes the value", () => {
    expect(JSON.stringify(rateLimitProblems(env({ SIGNOFF_PEPPER: "leaky-but-short" }), "import"))).not.toContain("leaky");
  });
});
