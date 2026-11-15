// Job-import journey against the ISOLATED LOCAL stack (app on :3100 with OPPORTUNITY_IMPORT_ENABLED=true and
// TINYFISH_MODE=stub, Supabase on 127.0.0.1). Fictional identity and fictional listings only. No provider is called:
// the stub serves https://jobs.example.com/<path> from lib/server/imports/tinyfish.ts and drafts deterministically.
//
// Matching needs Supermemory, which is deliberately unavailable locally. To check the REAL evaluator against the
// rules stored for an imported job, this script evaluates directly (every record as a candidate, no memory search)
// and saves that run through finalize_match_run, labelled as a local test fixture.
//
//   (set the same local env as the app) npx tsx scripts/e2e-import.mts            # flag on: both journeys
//   then restart the app with OPPORTUNITY_IMPORT_ENABLED=false and: npx tsx scripts/e2e-import.mts flag-off
// The fictional account's local-only credentials are kept between phases in E2E_STATE (mode 600).
import { randomBytes, randomUUID, createHash } from "node:crypto";
import puppeteer, { type Page } from "puppeteer-core";
import { createClient } from "@supabase/supabase-js";
import { evaluateRequirement } from "../lib/server/matching/evaluate";
import { toDbPayload } from "../lib/server/matching/payload";
import { toRequirement, type RequirementRow } from "../lib/server/opportunities/mappers";
import { EVIDENCE_COLUMNS, toEvidence, type EvidenceRow } from "../lib/supabase/mappers";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

const PHASE = process.argv[2] ?? "flag-on";
const STATE = process.env.E2E_STATE ?? join(tmpdir(), "qualitrail-e2e-import-state.json");
const run = randomUUID().slice(0, 6);
const email = `import-${run}@test.qualitrail.dev`;
const password = `Qt-${randomBytes(18).toString("base64url")}`;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
const errors: string[] = [];

/** Evaluate an imported job's STORED rules with the real evaluator and save via finalize_match_run (local fixture). */
async function evaluateAndSave(workerId: string, oppId: string) {
  const reqRows = ((await admin.from("requirements").select("*").eq("opportunity_id", oppId).order("position")).data ?? []) as RequirementRow[];
  const evRows = ((await admin.from("evidence").select(EVIDENCE_COLUMNS).eq("worker_id", workerId)).data ?? []) as unknown as EvidenceRow[];
  const evidence = evRows.map(toEvidence);
  const res = reqRows.map(toRequirement).map((r) => evaluateRequirement(r, evidence.map((e) => ({ evidence: e, memorySimilarity: null })), new Date().toISOString().slice(0, 10)));
  const started = await admin.rpc("start_match_run", { p_worker_id: workerId, p_opportunity_id: oppId });
  const runId = (started.data as { id: string }[])[0].id;
  const db = toDbPayload(res);
  const fin = await admin.rpc("finalize_match_run", { p_worker_id: workerId, p_run_id: runId, p_results: db.results, p_matches: db.matches, p_memory_warning: "LOCAL TEST FIXTURE: evaluated directly without memory search." });
  return { status: fin.data as string, results: res };
}

async function signIn(e: string, pw: string) {
  const p = await (await browser.createBrowserContext()).newPage();
  p.setDefaultTimeout(30000);
  p.on("pageerror", (x) => errors.push(x instanceof Error ? x.message : String(x)));
  await p.goto(`${APP}/sign-in`, { waitUntil: "networkidle0" });
  await p.type("input[name=email]", e);
  await p.type("input[name=password]", pw);
  await clickText(p, "Sign in");
  await p.waitForFunction(() => location.pathname !== "/sign-in");
  return p;
}

async function openReport(p: Page, oppId: string) {
  await p.goto(`${APP}/reports`, { waitUntil: "networkidle0" });
  await p.waitForSelector("select[aria-label=Job]");
  await p.select("select[aria-label=Job]", oppId);
  await p.waitForFunction(() => document.body.innerText.includes("Requirement by requirement"), { timeout: 30000 });
  await sleep(800);
  return text(p);
}
const printable = (p: Page) => p.evaluate(() => !([...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Print or save as PDF")) as HTMLButtonElement)?.disabled);

if (PHASE === "flag-off") {
  // Saved work must stay readable when new imports are switched off.
  try {
    const st = JSON.parse(readFileSync(STATE, "utf8")) as { email: string; password: string; urlJob: string; pastedJob: string; importId: string };
    const p = await signIn(st.email, st.password);
    const me = await api(p, "/api/me");
    check("/api/me reports job import off", me.j?.features?.jobImport === false, JSON.stringify(me.j?.features));
    check("starting an import answers 404", (await api(p, "/api/imports", "POST", { text: "x".repeat(60) })).s === 404);
    check("reading an import draft answers 404", (await api(p, `/api/imports/${st.importId}`)).s === 404);
    await p.goto(`${APP}/opportunities?job=${st.pastedJob}`, { waitUntil: "networkidle0" });
    await p.waitForFunction(() => document.body.innerText.includes("Your evidence fit"));
    const page = await text(p);
    check("import card hidden", !page.includes("See how your experience fits a job"));
    check("confirmed pasted job still opens with provenance, wording and fit summary", page.includes("Requirements quoted from listing text you supplied") && page.includes("Your evidence fit") && page.includes("EPA 608 Universal certification required"));
    const listed = await api(p, "/api/opportunities");
    check("both confirmed imported jobs still listed with import details", [st.urlJob, st.pastedJob].every((id) => listed.j?.opportunities?.some((o: { id: string; importInfo: unknown }) => o.id === id && o.importInfo)));
    // The flag-on phase added a record AFTER the URL job's run was saved, so that run is stale: readable, but printing
    // must stay off until matching runs again. The pasted job was matched after that record, so it stays printable.
    for (const [name, id, expectPrintable] of [["URL", st.urlJob, false], ["pasted", st.pastedJob, true]] as const) {
      const report = await openReport(p, id);
      const parts = {
        cannotAssess: report.includes("Can't assess automatically"),
        fit: report.includes("Your evidence fit"),
        printable: await printable(p),
        staleNotice: report.includes("Results are out of date"),
      };
      const ok = parts.cannotAssess && parts.fit && parts.printable === expectPrintable && parts.staleNotice === !expectPrintable;
      check(`${name} job report readable with four-way counts; ${expectPrintable ? "printable (current run)" : "printing off (stale run)"}`, ok, JSON.stringify(parts));
    }
    const latest = await api(p, `/api/matches/latest?opportunityId=${st.pastedJob}`);
    check("saved match run still served", latest.s === 200 && latest.j?.matchRun?.status === "completed");
  } catch (e) {
    check("aborted", false, (e as Error).message);
  } finally {
    check("no uncaught page errors", errors.length === 0, errors.slice(0, 2).join(" | "));
    await browser.close();
    const failed = results.filter((r) => !r).length;
    console.log(`\ne2e-import flag-off: ${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
  }
}

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
  check("current run can be printed", await printable(p));

  // 6. Pasted description: ordinary listing text with NO Markdown, through the UI, to a report.
  const PLAIN = [
    "HVAC Service Technician (fictional test listing)",
    "Fictional Comfort Co. - Mesa, AZ",
    "",
    "About the role",
    "We install and service residential heat pumps. This listing is invented for a QualiTrail test.",
    "",
    "Responsibilities",
    "Install and start up heat pump systems",
    "",
    "What you'll need:",
    "EPA 608 Universal certification required.",
    "Experience installing and starting up heat pumps",
    "Valid driver's license",
    "",
    "Nice to have:",
    "NATE certification",
    "",
    "Also:",
    "OSHA 10 card preferred",
    "Brazing experience",
    "",
    "Benefits",
    "Paid time off",
  ].join("\n");
  const doc = await admin.from("evidence").insert({ worker_id: workerId, type: "certification", title: "EPA 608 Universal certification card (FICTIONAL)", source_date: "2023-05-02", issuer: "Fictional Certifying Body", structured_data: { skills: [], activities: [], equipment: [], expirationDate: null, credentialNumber: null, summary: null }, source_kind: "seed", file_hash: sha(`doc${run}`), verification_status: "document_supplied", is_synthetic: true });
  check("a fictional supplied EPA document added", !doc.error, doc.error?.code);
  await p.goto(`${APP}/opportunities`, { waitUntil: "networkidle0" });
  await clickText(p, "Paste the listing text instead");
  await p.waitForSelector("textarea[name=text]");
  await p.$eval("textarea[name=text]", (el, v) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, PLAIN);
  await clickText(p, "Import job");
  await p.waitForFunction(() => location.pathname.startsWith("/opportunities/import/"), { timeout: 60000 });
  await p.waitForFunction(() => document.body.innerText.includes("Confirm and compare"));
  const pastedImport = new URL(p.url()).pathname.split("/").pop()!;
  const pr = await text(p);
  check("pasted review: 6 lines quoted from the text", /Requirements \(6 of 6 kept\)/.test(pr));
  check("pasted review labelled as supplied by the technician", pr.includes("Listing text supplied by you, not retrieved from the employer."));
  const pv = await api(p, `/api/imports/${pastedImport}`);
  const lines = (pv.j?.draft?.lines ?? []) as { originalText: string; originalPriority: string }[];
  check("priorities read from the text (inline + headings; unspecified when not stated)", JSON.stringify(lines.map((l) => l.originalPriority)) === JSON.stringify(["required", "required", "required", "preferred", "preferred", "unspecified"]), JSON.stringify(lines.map((l) => [l.originalText, l.originalPriority])));
  check("title, employer and location taken from the text", pv.j?.draft?.title === "HVAC Service Technician (fictional test listing)" && pv.j?.draft?.employer === "Fictional Comfort Co." && pv.j?.draft?.location === "Mesa, AZ");
  const confirmBtnDisabled = await p.evaluate(() => ([...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Confirm and compare")) as HTMLButtonElement).disabled);
  check("confirm is disabled until the warnings are acknowledged", confirmBtnDisabled);
  await p.evaluate(() => ([...document.querySelectorAll("label")].find((l) => l.textContent?.includes("I've read the warnings"))!.querySelector("input") as HTMLInputElement).click());
  await clickText(p, "Confirm and compare");
  await p.waitForFunction(() => location.pathname === "/opportunities" && location.search.includes("job="), { timeout: 60000 });
  const pastedJob = new URL(p.url()).searchParams.get("job")!;
  const pastedOpp = (await admin.from("opportunities").select("source_kind, source_url, import_warnings, title, employer, location").eq("id", pastedJob).single()).data;
  check("pasted job saved as supplied text, no source URL, warning kept", pastedOpp?.source_kind === "pasted_text" && pastedOpp?.source_url === null && pastedOpp?.import_warnings?.length === 1 && pastedOpp?.location === "Mesa, AZ");
  const pq = ((await admin.from("requirements").select("original_text, priority, original_priority, mandatory").eq("opportunity_id", pastedJob).order("position")).data ?? []);
  check("requirements stored verbatim with priorities; preferred lines not mandatory", pq.length === 6 && pq[0].original_text === "EPA 608 Universal certification required" && pq.map((r) => r.priority).join() === "required,required,required,preferred,preferred,unspecified" && pq.map((r) => r.mandatory).join() === "true,true,true,false,false,true");
  const pastedRun = await evaluateAndSave(workerId, pastedJob);
  const got = pastedRun.results.map((r) => r.assessment);
  check("finalize stored the run", pastedRun.status === "completed");
  check(
    "assessments: EPA documented, install+startup self-reported, licence/brazing/OSHA/NATE honest",
    JSON.stringify(got) === JSON.stringify(["evidence_found", "needs_review", "cannot_assess", "no_sufficient_evidence", "no_sufficient_evidence", "no_sufficient_evidence"]),
    JSON.stringify(got),
  );
  check("evidence links: EPA line links the supplied document directly", pastedRun.results[0].connections.some((c) => c.role === "direct" && c.verificationStatus === "document_supplied"));
  check("cannot_assess adds no missing documentation", pastedRun.results[2].missingDocumentation.length === 0);
  await p.goto(`${APP}/opportunities?job=${pastedJob}`, { waitUntil: "networkidle0" });
  await p.waitForFunction(() => document.body.innerText.includes("Your evidence fit"));
  const fit = (await text(p)).split("Your evidence fit")[1];
  check("fit summary: Required (3) / Preferred (2) / Priority not stated (1)", /Required \(3\)/.test(fit) && /Preferred \(2\)/.test(fit) && /Priority not stated \(1\)/.test(fit));
  const prep = await openReport(p, pastedJob);
  check("pasted report: supplied-text provenance and acknowledged warning", prep.includes("listing text the technician supplied") && prep.includes("Import warnings acknowledged by the technician"));
  check("pasted report: counts and priorities", /Evidence found\s*1/.test(prep) && /Can't assess automatically\s*1/.test(prep) && prep.includes("Priority not stated"));
  check("pasted report: supporting record listed for the EPA line", prep.includes("EPA 608 Universal certification card (FICTIONAL)"));
  check("pasted report printable", await printable(p));
  writeFileSync(STATE, JSON.stringify({ email, password, urlJob: oppId, pastedJob, importId }), { mode: 0o600 });
} catch (e) {
  check("aborted", false, (e as Error).message);
} finally {
  check("no uncaught page errors", errors.length === 0, errors.slice(0, 2).join(" | "));
  await browser.close();
  const failed = results.filter((r) => !r).length;
  console.log(`\ne2e-import: ${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}
