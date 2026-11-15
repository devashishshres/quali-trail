// Job-import journey against the ISOLATED LOCAL stack (app on :3100 with OPPORTUNITY_IMPORT_ENABLED=true and
// TINYFISH_MODE=stub, Supabase on 127.0.0.1). Fictional identity and fictional listings only. No provider is called:
// the stub serves https://jobs.example.com/<path> from lib/server/imports/tinyfish.ts and drafts deterministically.
//
// Matching needs Supermemory, which is deliberately unavailable locally. To check the REAL evaluator against the
// rules stored for an imported job, this script evaluates directly (every record as a candidate, no memory search)
// and saves that run through finalize_match_run, labelled as a local test fixture.
//
//   (set the same local env as the app) npx tsx scripts/e2e-import.mts
import { randomBytes, randomUUID, createHash } from "node:crypto";
import puppeteer, { type Page } from "puppeteer-core";
import { createClient } from "@supabase/supabase-js";
import { evaluateRequirement } from "../lib/server/matching/evaluate";
import { toDbPayload } from "../lib/server/matching/payload";
import { toRequirement, type RequirementRow } from "../lib/server/opportunities/mappers";
import { EVIDENCE_COLUMNS, toEvidence, type EvidenceRow } from "../lib/supabase/mappers";

const APP = process.env.E2E_APP_URL ?? "http://localhost:3100";
const SB = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(SB)) throw new Error("e2e-import only runs against a LOCAL Supabase stack");
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const admin = createClient(SB, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false } });
const results: boolean[] = [];
const check = (name: string, ok: unknown, detail = "") => {
  results.push(!!ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const text = (p: Page) => p.evaluate(() => document.body.innerText);
const api = (p: Page, path: string, method = "GET", body?: unknown) =>
  p.evaluate(
    async (path, method, body) => {
      const r = await fetch(path, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
      let j = null;
      try { j = await r.json(); } catch {}
      return { s: r.status, j };
    },
    path, method, body,
  ) as Promise<{ s: number; j: any }>; // eslint-disable-line @typescript-eslint/no-explicit-any -- test script reads loosely typed JSON
async function clickText(p: Page, label: string) {
  const ok = await p.evaluate((label) => {
    const el = [...document.querySelectorAll("button, a")].find((e) => e.textContent?.trim() === label && !(e as HTMLButtonElement).disabled) as HTMLElement | undefined;
    if (el) { el.scrollIntoView(); el.click(); return true; }
    return false;
  }, label);
  if (!ok) throw new Error(`no clickable "${label}"`);
}

const run = randomUUID().slice(0, 6);
const email = `import-${run}@test.qualitrail.dev`;
const password = `Qt-${randomBytes(18).toString("base64url")}`;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
const errors: string[] = [];
try {
  // Fictional technician with two fictional records.
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error) throw new Error(`createUser ${created.error.status}`);
  const p = await (await browser.createBrowserContext()).newPage();
  p.setDefaultTimeout(30000);
  p.on("pageerror", (e) => errors.push(e instanceof Error ? e.message : String(e)));
  await p.goto(`${APP}/sign-in`, { waitUntil: "networkidle0" });
  await p.type("input[name=email]", email);
  await p.type("input[name=password]", password);
  await clickText(p, "Sign in");
  await p.waitForFunction(() => location.pathname !== "/sign-in");
  const onboard = await api(p, "/api/onboarding", "POST", { role: "worker", name: `Import E2E ${run} (fictional)`, trade: "HVAC (test)" });
  check("fictional technician onboarded", onboard.s === 200, String(onboard.s));
  const me = await api(p, "/api/me");
  check("/api/me reports job import on", me.j?.features?.jobImport === true, JSON.stringify(me.j?.features));
  const workerId = me.j.worker.id as string;
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const ev = await admin.from("evidence").insert([
    { worker_id: workerId, type: "certification", title: "EPA Section 608 Technician Certification — Universal (FICTIONAL)", source_date: "2024-03-01", issuer: "Fictional Testing Org", structured_data: { skills: ["Refrigerant handling"], activities: [], equipment: [], expirationDate: null, credentialNumber: null, summary: "Fictional record for a local test." }, source_kind: "manual_text", file_hash: sha(`epa${run}`), verification_status: "self_reported", is_synthetic: true },
    { worker_id: workerId, type: "work_record", title: "Heat pump install and startup — fictional residential job", source_date: "2025-06-10", issuer: "Fictional Air Co.", structured_data: { skills: [], activities: ["Installed residential heat pump", "Started up heat pump and checked charge"], equipment: ["3-ton heat pump"], expirationDate: null, credentialNumber: null, summary: null }, source_kind: "manual_text", file_hash: sha(`hp${run}`), verification_status: "self_reported", is_synthetic: true },
  ]);
  check("two fictional records added", !ev.error, ev.error?.code);

  // 1. Unsafe and unsupported inputs never reach the provider.
  const bad = await api(p, "/api/imports", "POST", { url: "http://169.254.169.254/latest/meta-data" });
  check("metadata address refused before any retrieval (400)", bad.s === 400 && /public website/.test(bad.j?.error?.message ?? ""), String(bad.s));
  const blocked = await api(p, "/api/imports", "POST", { url: "https://jobs.example.com/blocked" });
  check("bot-blocked listing reported honestly, not retryable, paste offered", blocked.s === 201 && blocked.j?.status === "failed" && blocked.j?.error?.retryable === false && /Paste the listing text/.test(blocked.j?.error?.message ?? ""), JSON.stringify(blocked.j?.error));

  // 2. Import through the UI.
  await p.goto(`${APP}/opportunities`, { waitUntil: "networkidle0" });
  check("import card offered", (await text(p)).includes("See how your experience fits a job"));
  await p.type("input[name=url]", "https://jobs.example.com/hvac-tech");
  await clickText(p, "Import job");
  await p.waitForFunction(() => location.pathname.startsWith("/opportunities/import/"), { timeout: 60000 });
  await p.waitForFunction(() => document.body.innerText.includes("Confirm and compare"));
  const importId = new URL(p.url()).pathname.split("/").pop()!;
  const review = await text(p);
  check("review shows 6 verbatim lines, nothing saved yet", /Requirements \(6 of 6 kept\)/.test(review));
  check("supported line explains what will be checked", review.includes("QualiTrail will check: EPA Section 608 certification (Type II or Universal)"));
  check("duration line is not assessed automatically", /3\+ years of HVAC installation experience[\s\S]*?Can't assess automatically\./.test(review));
  check("listing priority shown for preferred lines", (review.match(/Listing: Preferred/g) ?? []).length === 2);
  const oppsBefore = await admin.from("opportunities").select("id").eq("worker_id", workerId);
  check("no job exists before confirmation", oppsBefore.data?.length === 0);

  // Edit: reword line 1 for display, mark line 2 for manual review, remove "Brazing experience".
  // Passed as a string: tsx would otherwise inject a helper the page doesn't have.
  await p.evaluate(`(() => {
    const items = [...document.querySelectorAll("ol li")];
    const input = items[0].querySelector("input.field");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "EPA 608 (Type II or Universal)");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    items[1].querySelector("input[type=checkbox]").click();
    [...items[5].querySelectorAll("button")].find((b) => b.textContent.includes("Remove")).click();
  })()`);
  await sleep(300);
  check("removing a line updates the count", (await text(p)).includes("Requirements (5 of 6 kept)"));
  await clickText(p, "Confirm and compare");
  await p.waitForFunction(() => location.pathname === "/opportunities" && location.search.includes("job="), { timeout: 60000 });
  const oppId = new URL(p.url()).searchParams.get("job")!;

  // 3. Stored exactly as reviewed.
  const opp = (await admin.from("opportunities").select("*").eq("id", oppId).single()).data;
  check("job saved with provenance", opp?.source_kind === "listing_url" && opp?.import_id === importId && opp?.removed_count === 1 && opp?.edited_count === 1 && opp?.source_url === "https://jobs.example.com/hvac-tech", JSON.stringify({ k: opp?.source_kind, r: opp?.removed_count, e: opp?.edited_count }));
  const reqRows = ((await admin.from("requirements").select("*").eq("opportunity_id", oppId).order("position")).data ?? []) as RequirementRow[];
  const kinds = reqRows.map((r) => (r.criteria_json as { rule?: { kind: string } }).rule?.kind);
  check("rules built from original wording (manual-review line forced to review)", JSON.stringify(kinds) === JSON.stringify(["supported", "review_only", "review_only", "review_only", "supported"]), JSON.stringify(kinds));
  check("employer wording kept; display edit stored separately", reqRows[0].original_text === "EPA 608 Type II or Universal certification" && reqRows[0].display_text === "EPA 608 (Type II or Universal)");
  const imp = (await admin.from("opportunity_imports").select("status, content_text").eq("id", importId).single()).data;
  check("listing text cleared after confirmation", imp?.status === "confirmed" && imp?.content_text === null);
  const again = await api(p, `/api/imports/${importId}/confirm`, "POST", { version: 99, acknowledgeWarnings: false });
  check("repeat confirmation returns the same job (idempotent)", again.s === 200 && again.j?.opportunityId === oppId && again.j?.repeated === true);
  const redraft = await api(p, `/api/imports/${importId}/draft`, "POST");
  check("a confirmed draft is never regenerated", redraft.s === 200 && redraft.j?.status === "confirmed");

  // 4. Pasted text: labelled, and warnings must be acknowledged.
  const pasted = await api(p, "/api/imports", "POST", { text: "Requirements:\n- OSHA 10 card\n- Valid driver's license\nThis is a fictional listing for a local test." });
  check("pasted text drafted and labelled as supplied by the technician", pasted.s === 201 && pasted.j?.warnings?.some((w: string) => /supplied by you/.test(w)), JSON.stringify(pasted.j?.warnings));
  const noAck = await api(p, `/api/imports/${pasted.j.id}/confirm`, "POST", { version: pasted.j.version, acknowledgeWarnings: false });
  check("confirming without acknowledging warnings is refused", noAck.s === 400);

  // 5. Evaluate the stored rules with the real evaluator, save via finalize_match_run, then read the UI.
  const evRows = ((await admin.from("evidence").select(EVIDENCE_COLUMNS).eq("worker_id", workerId)).data ?? []) as unknown as EvidenceRow[];
  const evidence = evRows.map(toEvidence);
  const reqs = reqRows.map(toRequirement);
  const res = reqs.map((r) => evaluateRequirement(r, evidence.map((e) => ({ evidence: e, memorySimilarity: null })), new Date().toISOString().slice(0, 10)));
  const started = await admin.rpc("start_match_run", { p_worker_id: workerId, p_opportunity_id: oppId });
  const runId = (started.data as { id: string }[])[0].id;
  const db = toDbPayload(res);
  const fin = await admin.rpc("finalize_match_run", { p_worker_id: workerId, p_run_id: runId, p_results: db.results, p_matches: db.matches, p_memory_warning: "LOCAL TEST FIXTURE: evaluated directly without memory search." });
  check("finalize_match_run stores cannot_assess results", fin.data === "completed", String(fin.data ?? fin.error?.code));
  check("evaluator: EPA line, manual-review line, duration, driving, NATE", JSON.stringify(res.map((r) => r.assessment)) === JSON.stringify(["needs_review", "cannot_assess", "cannot_assess", "cannot_assess", "no_sufficient_evidence"]), JSON.stringify(res.map((r) => r.assessment)));

  await p.goto(`${APP}/opportunities?job=${oppId}`, { waitUntil: "networkidle0" });
  await p.waitForFunction(() => document.body.innerText.includes("Your evidence fit"));
  const page = await text(p);
  check("fit summary grouped by priority, no score", /Your evidence fit[\s\S]*Required \(4\)[\s\S]*Preferred \(1\)/.test(page) && !/%|probability|likely/i.test(page.split("Your evidence fit")[1].split("Requirements")[0]));
  check("fit summary says missing documentation is not missing ability", page.includes("Missing documentation is not missing ability"));
  check("display edit labelled; employer wording primary", page.includes("Your wording (display only, not used for matching): EPA 608 (Type II or Universal)"));
  check("provenance and removed/edited counts shown", page.includes("Requirements quoted from the public listing") && page.includes("You removed 1 line"));

  await p.goto(`${APP}/reports`, { waitUntil: "networkidle0" });
  await p.select("select[aria-label=Job]", oppId).catch(() => {});
  await p.waitForFunction(() => document.body.innerText.includes("Requirement by requirement"), { timeout: 30000 });
  await sleep(800);
  const report = await text(p);
  check("report counts all four assessments", /Can't assess automatically\s*3/.test(report), (report.match(/Can't assess automatically\s*\d/) ?? [""])[0]);
  check("report keeps employer wording and labels the technician's", report.includes("EPA 608 Type II or Universal certification") && report.includes("Technician's wording (display only): EPA 608 (Type II or Universal)"));
  check("report discloses retrieval and removal", report.includes("quoted word-for-word from the public listing") && report.includes("removed 1 listing line"));
  check("report explains cannot_assess without judging the person", report.includes("It says nothing about whether you meet it"));
  const printable = await p.evaluate(() => !([...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Print or save as PDF")) as HTMLButtonElement)?.disabled);
  check("current run can be printed", printable);
} catch (e) {
  check("aborted", false, (e as Error).message);
} finally {
  check("no uncaught page errors", errors.length === 0, errors.slice(0, 2).join(" | "));
  await browser.close();
  const failed = results.filter((r) => !r).length;
  console.log(`\ne2e-import: ${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}
