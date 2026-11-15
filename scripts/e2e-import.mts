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
  return { status: fin.data as string, results: res, runId };
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
  // The job selector exists only when the technician has more than one job.
  await p.waitForFunction(() => document.body.innerText.includes("Requirement by requirement") || !!document.querySelector("select[aria-label=Job]"), { timeout: 30000 });
  if (await p.$("select[aria-label=Job]")) await p.select("select[aria-label=Job]", oppId);
  await p.waitForFunction(() => document.body.innerText.includes("Requirement by requirement"), { timeout: 30000 });
  await sleep(800);
  return text(p);
}
/** Pasted job, required first: install+startup (self-reported), licence, then NATE, OSHA 10, brazing. EPA is found. */
const EXPECTED_KINDS = ["confirm", "manual_review", "upload", "upload", "upload"];
const BANNED = /\b(lack|lacks|lacking|unqualified|not qualified|incapable|course|courses|enrol|enroll|hiring|hired|likely|probability|percent)\b/i;

/** Reads the "Your next steps" section on the current page. */
async function nextStepsOnPage(p: Page) {
  await p.waitForSelector("[data-section=next-steps]");
  return p.evaluate(() => {
    const sec = document.querySelector("[data-section=next-steps]") as HTMLElement;
    const items = [...sec.querySelectorAll("[data-step-kind]")] as HTMLElement[];
    const byKind: Record<string, string> = {};
    for (const i of items) byKind[i.dataset.stepKind!] = `${byKind[i.dataset.stepKind!] ?? ""} ${i.innerText}`;
    return { kinds: items.map((i) => i.dataset.stepKind!), byKind, text: sec.innerText, links: [...sec.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "") };
  });
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
    check("AI explanations off: not reported, no offer, route answers 404", me.j?.features?.aiExplanations === false && !page.includes("Explain related evidence") && (await api(p, `/api/matches/${randomUUID()}/explanations`, "POST")).s === 404);
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

    // "Your next steps" with sign-off and supervisor review ON (this phase's app env). Following a link sends nothing.
    const workerId = (await admin.from("opportunity_imports").select("worker_id").eq("id", st.importId).single()).data!.worker_id as string;
    const countRequests = async () => {
      const a = await admin.from("signoff_requests").select("id", { count: "exact", head: true }).eq("worker_id", workerId);
      const b = await admin.from("review_requests").select("id", { count: "exact", head: true }).eq("worker_id", workerId);
      return `${a.count}/${b.count}`;
    };
    const before = await countRequests();
    await p.goto(`${APP}/opportunities?job=${st.pastedJob}`, { waitUntil: "networkidle0" });
    const ns = await nextStepsOnPage(p);
    check("next steps (flows on): offers supervisor review and customer acknowledgment, says nothing is sent", /ask a supervisor to review it or ask the customer to acknowledge it/.test(ns.byKind.confirm ?? "") && /Nothing is sent until you fill in and submit a request there/.test(ns.byKind.confirm ?? ""));
    const recordHref = ns.links.find((h) => /^\/evidence#evidence-/.test(h));
    const mutating: string[] = [];
    const onReq = (r: { method: () => string; url: () => string }) => { if (r.method() !== "GET" && r.method() !== "HEAD" && r.url().startsWith(APP)) mutating.push(`${r.method()} ${new URL(r.url()).pathname}`); };
    p.on("request", onReq);
    await p.evaluate((h) => (document.querySelector(`[data-section=next-steps] a[href="${h}"]`) as HTMLElement).click(), recordHref!);
    await p.waitForFunction(() => location.pathname === "/evidence", { timeout: 30000 });
    const recId = recordHref!.split("evidence-")[1];
    await p.waitForFunction((id) => !!document.getElementById(`evidence-${id}`)?.innerText.includes("Customer sign-off"), { timeout: 30000 }, recId).catch(async (e) => {
      const seen = await p.evaluate((id) => ({ url: location.pathname + location.hash, el: document.getElementById(`evidence-${id}`)?.innerText.slice(0, 400) ?? "no element", ids: [...document.querySelectorAll("[id^=evidence-]")].length }), recId);
      throw new Error(`${(e as Error).message} ${JSON.stringify(seen)}`);
    });
    await sleep(1000);
    p.off("request", onReq);
    const panel = await p.evaluate((id) => document.getElementById(`evidence-${id}`)!.innerText, recId);
    check("next steps link opens that record with the existing sign-off and review panels", panel.includes("Customer sign-off") && /supervisor/i.test(panel));
    check("following the link sends nothing: no write requests, no new sign-off or review requests", mutating.length === 0 && (await countRequests()) === before, `${mutating.join(", ")} ${before}`);

    // Older saved results: a run stored with the plain gap strings older versions wrote (no codes), read by today's UI.
    const urlReqs = ((await admin.from("requirements").select("id, original_text, mandatory, position").eq("opportunity_id", st.urlJob).order("position")).data ?? []) as { id: string; original_text: string; mandatory: boolean }[];
    const legacy = urlReqs.map((q, i) => ({
      requirementId: q.id,
      originalText: q.original_text,
      mandatory: q.mandatory,
      assessment: (["no_sufficient_evidence", "needs_review", "needs_review", "evidence_found", "no_sufficient_evidence"] as const)[i % 5],
      connections: [],
      explanation: "Saved by an older version (fixture).",
      uncertainties: [],
      missingDocumentation: [
        [`A record that directly documents: ${q.original_text}`],
        ['"Older job sheet (FICTIONAL)" does not state a date.'],
        ["A supporting document or independent confirmation for this record"],
        [],
        ["Some wording an older version might have stored."],
      ][i % 5],
    }));
    const started = await admin.rpc("start_match_run", { p_worker_id: workerId, p_opportunity_id: st.urlJob });
    const fin = await admin.rpc("finalize_match_run", { p_worker_id: workerId, p_run_id: (started.data as { id: string }[])[0].id, p_results: toDbPayload(legacy).results, p_matches: [], p_memory_warning: "LOCAL TEST FIXTURE: older-format saved result." });
    check("an older-format run is stored", fin.data === "completed", String(fin.data ?? fin.error?.code));
    await openReport(p, st.urlJob);
    const old = await nextStepsOnPage(p);
    const expectedOld = legacy.flatMap((r) => (r.assessment === "evidence_found" ? [] : [["upload", "clarify", "confirm", "", "clarify"][legacy.indexOf(r) % 5]]));
    check("older saved results produce next steps in the report", old.kinds.slice().sort().join() === expectedOld.slice().sort().join(), `${JSON.stringify(old.kinds)} vs ${JSON.stringify(expectedOld)}`);
    check("an unrecognised older message is shown as written", old.text.includes("Some wording an older version might have stored."));
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

if (PHASE === "explain") {
  // "Related evidence — AI-assisted explanation" with AI_EXPLANATIONS_ENABLED=true and AI_EXPLANATIONS_MODE=stub:
  // deterministic stand-ins for Supermemory and Gemini, so NOTHING leaves this machine. Separate fictional technicians.
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const newTech = async (tag: string) => {
    const e = `explain-${tag}-${run}@test.qualitrail.dev`;
    const created = await admin.auth.admin.createUser({ email: e, password, email_confirm: true });
    if (created.error) throw new Error(`createUser ${created.error.status}`);
    const p = await signIn(e, password);
    const on = await api(p, "/api/onboarding", "POST", { role: "worker", name: `Explain E2E ${tag} ${run} (fictional)`, trade: "HVAC (test)" });
    if (on.s !== 200) throw new Error(`onboarding ${on.s}`);
    return { p, workerId: (await api(p, "/api/me")).j.worker.id as string };
  };
  // Marked indexed with the memory document id a real index would store (lib/server/memory/conventions.ts), so the
  // app's reconciliation leaves them alone; the stub search then reads them without Supermemory.
  const record = (workerId: string, title: string, activities: string[], summary: string | null = null, id = randomUUID()) => ({
    id, memory_document_id: `${id}_v1`, worker_id: workerId, type: "work_record", title, source_date: "2025-04-02", issuer: "Fictional Air Co.",
    structured_data: { skills: [], activities, equipment: [], expirationDate: null, credentialNumber: null, summary },
    source_kind: "manual_text", file_hash: sha(`${title}${run}`), verification_status: "self_reported", is_synthetic: true, index_status: "indexed",
  });
  const listing = (title: string) => [
    title, "Fictional Cooling Co. - Tempe, AZ", "", "This listing is invented for a QualiTrail test.", "",
    "Requirements:",
    "EPA 608 Universal certification required",
    "Proficiency with brazing, pressure testing, evacuation, refrigerant charging, and system start-up",
    "Valid driver's license",
    "3+ years of residential HVAC installation experience",
    "Ability to read blueprints and schematics",
    "Comfortable working in attics and crawl spaces",
    "Experience with ductwork or line sets",
  ].join("\n");
  const importJob = async (p: Page, title: string) => {
    const d = await api(p, "/api/imports", "POST", { text: listing(title) });
    if (d.s !== 201) throw new Error(`import ${d.s}`);
    const c = await api(p, `/api/imports/${d.j.id}/confirm`, "POST", { version: d.j.version, acknowledgeWarnings: true });
    if (c.s !== 200) throw new Error(`confirm ${c.s}`);
    return c.j.opportunityId as string;
  };
  const snapshot = async (workerId: string, runId: string) => JSON.stringify({
    results: (await admin.from("requirement_results").select("*").eq("match_run_id", runId).order("requirement_id")).data,
    matches: (await admin.from("evidence_matches").select("*").eq("match_run_id", runId).order("id")).data,
    run: (await admin.from("match_runs").select("status, evidence_revision").eq("id", runId).single()).data,
    evidence: (await admin.from("evidence").select("id, verification_status, version").eq("worker_id", workerId).order("id")).data,
  });
  const fitText = async (p: Page) => (await text(p)).split("Your evidence fit")[1]?.split("Requirements")[0] ?? "";
  const reportCounts = (t: string) => ["Evidence found", "Needs review", "No sufficient evidence found", "Can't assess automatically"].map((k) => (t.match(new RegExp(`${k}\\s*\\d+`)) ?? [""])[0]).join("|");
  const panels = (p: Page) => p.evaluate(() => [...document.querySelectorAll("[data-section=related-evidence] [data-related-kind]")].map((el) => ({ kind: (el as HTMLElement).dataset.relatedKind!, text: (el as HTMLElement).innerText, links: [...el.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "") })));
  const stored = async (runId: string) => (await admin.from("match_run_explanations").select("*").eq("match_run_id", runId).maybeSingle()).data;
  const POSITIVE = /\b(you (?:meet|qualify|are qualified|satisfy)|meets? (?:this|the) requirement|is eligible|you are eligible|verified record|proves?)\b/i;

  try {
    const { p, workerId } = await newTech("a");
    const me = await api(p, "/api/me");
    check("/api/me reports AI explanations on (stub mode, isolated local)", me.j?.features?.aiExplanations === true, JSON.stringify(me.j?.features));
    const recs = await admin.from("evidence").insert([
      record(workerId, "Line set replacement (FICTIONAL)", ["Brazed copper line set"]),
      record(workerId, "Helper day on a mini-split job (FICTIONAL)", ["Assisted the lead with evacuation"]),
      record(workerId, "Mini-split install (FICTIONAL)", ["Installed ductless mini-split", "Startup was done by another crew"]),
      record(workerId, "Service visit (FICTIONAL)", ["Did not pressure test the system", "Replaced capacitor"]),
      record(workerId, "Site visit notes (FICTIONAL)", ["Visited site"], "Charged the system to spec. Customer Jane Roe, jane@example.com, 12 Oak Street"),
    ]).select("id, title");
    check("five fictional, indexed records added", !recs.error && recs.data?.length === 5, recs.error?.code);
    const own = new Set((recs.data ?? []).map((r) => r.id as string));

    // A. Supported, partial, assisted, by-others, negated, summary-only, unrelated and eligibility lines.
    const jobA = await importJob(p, "Fictional Mini-Split Installer (explain test)");
    const runA = await evaluateAndSave(workerId, jobA);
    const kindsA = runA.results.map((r) => r.assessment);
    check("checked assessments: EPA honest gap, every other line cannot_assess", JSON.stringify(kindsA) === JSON.stringify(["no_sufficient_evidence", ...Array(6).fill("cannot_assess")]), JSON.stringify(kindsA));
    const before = await snapshot(workerId, runA.runId);
    await p.goto(`${APP}/opportunities?job=${jobA}`, { waitUntil: "networkidle0" });
    await p.waitForSelector("[data-section=explain-offer]");
    const fitBefore = await fitText(p);
    const offer = await p.$eval("[data-section=explain-offer]", (el) => (el as HTMLElement).innerText);
    check("offer states what is sent and what never is", /6 lines couldn.t be assessed/.test(offer) && /redacted, not anonymous/.test(offer) && /never sends your summary, files, signatures, customer details, comments or profile/.test(offer) && /does not change your checked results/.test(offer));
    check("nothing generated before the technician asks", (await stored(runA.runId)) === null);
    await clickText(p, "Explain related evidence");
    await p.waitForSelector("[data-section=related-evidence]", { timeout: 60000 });
    await sleep(500);
    const pa = await panels(p);
    check("one panel per cannot_assess line, in listing order", JSON.stringify(pa.map((x) => x.kind)) === JSON.stringify(["ai", "eligibility", "eligibility", "no_related", "eligibility", "ai"]), JSON.stringify(pa.map((x) => x.kind)));
    const sec = await p.$eval("[data-section=related-evidence]", (el) => (el as HTMLElement).innerText);
    check("section labelled: not a checked match, changes no counts, AI parts can be wrong", sec.includes("Related evidence — AI-assisted explanation") && sec.includes("Not a checked match") && sec.includes("does not change the assessment above"));
    const tasks = pa[0]?.text ?? "";
    console.log(`      breakdown: ${(tasks.match(/From your records' wording: (.*)/) ?? ["", "(none)"])[1]}`);
    check("partial support: only brazing documented", /From your records' wording: Brazing documented; /.test(tasks));
    check("assisted, done by others, not done and summary-only are stated as such", /evacuation: assisted or observed only/.test(tasks) && /startup: done by someone else/.test(tasks) && /pressure testing: the record says it was not done/.test(tasks) && /refrigerant charging: mentioned only in a record's summary/.test(tasks), tasks.split("\n").find((l) => l.includes("wording")));
    const shared = await p.$$eval("[data-shared-steps] li", (els) => els.map((el) => ({ kind: (el as HTMLElement).dataset.sharedStepKind, text: (el as HTMLElement).innerText })));
    check("AI-written parts are labelled; the employer's wording is shown, not restated", !/What this asks for/.test(sec) && (/Suggested next step \(AI-written\)/.test(tasks) || shared.some((x) => x.kind === "ai" && /^\(AI-written\)/.test(x.text))), JSON.stringify(shared));
    check("a next step shared by several lines is listed once, with its line count", shared.every((x) => /\(\d+ lines\)$/.test(x.text)) && pa.every((x) => !shared.some((s) => x.text.includes(s.text.replace(/^\(AI-written\) /, "").replace(/ \(\d+ lines\)$/, "")))), JSON.stringify(shared));
    check("record descriptions are quoted from the record, not AI-written", /Records the AI linked to this line \(quoted from each record\)/.test(tasks) && tasks.includes('Work performed: "Brazed copper line set" (self-reported).') && !/AI-written descriptions/.test(tasks));
    check("the task check's limitations are listed under 'Not established or unclear'", ["evacuation: assisted or observed only", "startup: done by someone else", "pressure testing: the record says it was not done", "refrigerant charging: mentioned only in a record's summary"].every((x) => (tasks.split("Not established or unclear")[1] ?? "").includes(x)));
    check("alternatives (ductwork OR line sets) stated as such", /The line accepts any one of these\. Line sets documented; ductwork not established\./.test(pa[5]?.text ?? ""));
    const elig = pa.filter((x) => x.kind === "eligibility");
    check("eligibility lines: clarification only, no AI-written part, nothing inferred", elig.length === 3 && elig.every((x) => /What would need clarifying/.test(x.text) && !/AI-written/.test(x.text) && !POSITIVE.test(x.text)), elig.map((x) => x.text.slice(0, 80)).join(" | "));
    check("duration line: task records shown as context only", /context only; they do not establish this condition/.test(elig[1]?.text ?? ""));
    check("unrelated line: says no related record, nothing positive", /No related record was found/.test(pa[3]?.text ?? "") && !/Records that may relate/.test(pa[3]?.text ?? ""));
    check("no panel claims the technician meets or is verified for anything", pa.every((x) => !POSITIVE.test(x.text)));
    const links = pa.flatMap((x) => x.links).map((h) => h.split("evidence-")[1]);
    check("every cited record is one of this technician's records", links.length > 0 && links.every((id) => own.has(id)), links.join(","));
    const rowA = await stored(runA.runId);
    const cited = ((rowA?.items ?? []) as { related: { evidenceId: string }[] }[]).flatMap((i) => i.related.map((r) => r.evidenceId));
    check("stored: completed, AI ok, no rejected references, only supplied ids", rowA?.status === "completed" && rowA?.ai_status === "ok" && rowA?.rejected_references === 0 && cited.every((id) => own.has(id)), JSON.stringify({ s: rowA?.status, a: rowA?.ai_status, r: rowA?.rejected_references }));
    check("stored explanation carries no assessment and no summary or customer details", !JSON.stringify(rowA?.items).includes('"assessment"') && !/Jane Roe|jane@example\.com|Oak Street|Charged the system/.test(JSON.stringify(rowA?.items)));
    check("checked results, evidence links, run and verification statuses unchanged", (await snapshot(workerId, runA.runId)) === before);
    await p.reload({ waitUntil: "networkidle0" });
    await p.waitForSelector("[data-section=related-evidence]");
    const fitAfter = await fitText(p);
    const counts = (t: string) => t.split("Your next step")[0];
    check("fit summary counts identical after explaining", counts(fitAfter) === counts(fitBefore) && /Can.t assess automatically\n6/.test(fitAfter), `${JSON.stringify(fitBefore.slice(0, 300))} vs ${JSON.stringify(fitAfter.slice(0, 300))}`);
    const again = await api(p, `/api/matches/${runA.runId}/explanations`, "POST");
    const rowA2 = await stored(runA.runId);
    const kindsOf = (xs: unknown) => JSON.stringify(((xs ?? []) as { kind: string; requirementId: string }[]).map((i) => `${i.requirementId}:${i.kind}`));
    const sameKinds = kindsOf(again.j?.explanations?.items) === kindsOf(rowA?.items) && kindsOf(rowA?.items).length > 2;
    check("asking again returns the saved explanation, no new generation", again.s === 200 && rowA2?.attempts === 1 && rowA2?.updated_at === rowA?.updated_at && sameKinds, `${again.s} attempts=${rowA2?.attempts} sameTime=${rowA2?.updated_at === rowA?.updated_at} sameKinds=${sameKinds}`);

    const rep = await openReport(p, jobA);
    check("report: related-evidence section after the checked results", (await p.$("[data-section=related-evidence]")) !== null && rep.indexOf("Your next steps") < rep.indexOf("Related evidence — AI-assisted explanation"));
    check("report: counts are the checked ones (6 cannot assess, 1 no sufficient evidence)", /Can't assess automatically\s*6/.test(rep) && /No sufficient evidence found\s*1/.test(rep), reportCounts(rep));
    await p.emulateMediaType("print");
    const pv = await p.evaluate(() => {
      const s = document.querySelector("[data-section=related-evidence]") as HTMLElement | null;
      const a = [...(s?.querySelectorAll("a") ?? [])] as HTMLElement[];
      return { shown: !!s && s.offsetParent !== null, linksHidden: a.length > 0 && a.every((x) => x.offsetParent === null) };
    });
    await p.emulateMediaType("screen");
    check("report: section prints, on-screen record links left out", pv.shown && pv.linksHidden, JSON.stringify(pv));
    check("report: still printable", await printable(p));

    // B. A model reference to a record that was never supplied withholds that WHOLE explanation.
    const jobB = await importJob(p, "Fictional Service Tech (stub:bad-ref)");
    const runB = await evaluateAndSave(workerId, jobB);
    const xb = await api(p, `/api/matches/${runB.runId}/explanations`, "POST");
    const bItems = (xb.j?.explanations?.items ?? []) as { kind: string; withheld: string | null; related: { evidenceId: string }[] }[];
    check("unknown reference: counted, and the whole AI explanation for that line withheld", xb.s === 200 && xb.j.explanations.rejectedReferences === 1 && bItems[0]?.kind === "ai_unavailable" && bItems[0]?.withheld === "unknown_reference" && bItems[0]?.related.length === 0, JSON.stringify({ s: xb.s, r: xb.j?.explanations?.rejectedReferences, k: bItems[0]?.kind, w: bItems[0]?.withheld }));
    check("unknown reference: the other AI line is unaffected", bItems[5]?.kind === "ai" && bItems.flatMap((i) => i.related.map((r) => r.evidenceId)).every((id) => own.has(id)));
    await p.goto(`${APP}/opportunities?job=${jobB}`, { waitUntil: "networkidle0" });
    await p.waitForSelector("[data-section=related-evidence]");
    const tb = await text(p);
    check("page says the reference was removed and why the line's AI text was withheld", tb.includes("1 reference the AI gave did not match a record you supplied and was removed") && tb.includes("The AI text for this line was withheld because it cited a record that wasn't supplied for this line"));

    // C. The model failing keeps the deterministic content; checked results are untouched.
    const jobC = await importJob(p, "Fictional Installer (stub:fail)");
    const runC = await evaluateAndSave(workerId, jobC);
    const beforeC = await snapshot(workerId, runC.runId);
    await p.goto(`${APP}/opportunities?job=${jobC}`, { waitUntil: "networkidle0" });
    await p.waitForSelector("[data-section=explain-offer]");
    await clickText(p, "Explain related evidence");
    await p.waitForSelector("[data-section=related-evidence]", { timeout: 60000 });
    const pc = await panels(p);
    check("model failure: banner, deterministic breakdown kept, eligibility and no-related unchanged", (await text(p)).includes("The AI step failed") && JSON.stringify(pc.map((x) => x.kind)) === JSON.stringify(["ai_unavailable", "eligibility", "eligibility", "no_related", "eligibility", "ai_unavailable"]) && /Brazing/.test(pc[0]?.text ?? "") && !/AI-written/.test(pc.map((x) => x.text).join(" ")), JSON.stringify(pc.map((x) => x.kind)));
    check("model failure: checked results unchanged", (await snapshot(workerId, runC.runId)) === beforeC && (await stored(runC.runId))?.ai_status === "failed");

    // C2. Ungrounded or contradicting AI text is withheld as a whole (stub hooks write it on the first line).
    for (const [hook, why] of [["stub:claim", "fulfilment_claim"], ["stub:soft-claim", "worker_claim"], ["stub:contradict", "contradicts_records"]] as const) {
      const job = await importJob(p, `Fictional Installer (${hook})`);
      const r = await evaluateAndSave(workerId, job);
      const before2 = await snapshot(workerId, r.runId);
      const x = await api(p, `/api/matches/${r.runId}/explanations`, "POST");
      const it0 = x.j?.explanations?.items?.[0];
      check(`${hook}: whole AI explanation withheld (${why}); deterministic check kept; results unchanged`, x.s === 200 && it0?.kind === "ai_unavailable" && it0?.withheld === why && /Brazing documented/.test(it0?.breakdown?.sentence ?? "") && (await snapshot(workerId, r.runId)) === before2 && !/satisfy|can do this work|was performed/i.test(JSON.stringify(x.j?.explanations)), JSON.stringify({ s: x.s, k: it0?.kind, w: it0?.withheld }));
    }

    // C3. Repeated requests make one generation: parallel API calls, and a double click in the UI.
    const jobP = await importJob(p, "Fictional Installer (parallel)");
    const runP = await evaluateAndSave(workerId, jobP);
    const par = await Promise.all([1, 2, 3].map(() => api(p, `/api/matches/${runP.runId}/explanations`, "POST")));
    const rowP = await stored(runP.runId);
    check("three parallel requests → one generation (one claim, one attempt); others get the saved one or 'busy'", par.some((x) => x.s === 200) && par.every((x) => x.s === 200 || x.s === 429) && rowP?.attempts === 1 && (await admin.from("match_run_explanations").select("id").eq("match_run_id", runP.runId)).data?.length === 1, par.map((x) => x.s).join(","));
    const jobU = await importJob(p, "Fictional Installer (double click)");
    const runU = await evaluateAndSave(workerId, jobU);
    await p.goto(`${APP}/opportunities?job=${jobU}`, { waitUntil: "networkidle0" });
    await p.waitForSelector("[data-section=explain-offer]");
    let posts = 0;
    const onPost = (r: { method(): string; url(): string }) => { if (r.method() === "POST" && r.url().includes("/explanations")) posts += 1; };
    p.on("request", onPost);
    await p.evaluate(() => { const b = [...document.querySelectorAll("[data-section=explain-offer] button")][0] as HTMLButtonElement; b.click(); b.click(); b.click(); });
    await p.waitForSelector("[data-section=related-evidence]", { timeout: 60000 });
    await sleep(500);
    p.off("request", onPost);
    check("a triple click in the UI sends one request and shows no error", posts === 1 && (await stored(runU.runId))?.attempts === 1 && !(await text(p)).includes("Too many requests"), `posts=${posts}`);

    // E0. Records change after an explanation: it is never shown as current, and the stale run is not re-explained.
    await admin.from("evidence").insert(record(workerId, "Record added after explaining (FICTIONAL)", ["Installed condensate line"]));
    await p.goto(`${APP}/opportunities?job=${jobA}`, { waitUntil: "networkidle0" });
    await p.waitForSelector("[data-section=related-evidence]");
    const stalePanels = await p.evaluate(() => ({ banner: !!document.querySelector("[data-section=related-evidence] [data-out-of-date]"), panels: document.querySelectorAll("[data-section=related-evidence] [data-related-kind]").length, stale: document.querySelectorAll("[data-section=related-evidence] [data-stale]").length }));
    check("stale run: explanation marked out of date on the job page, every line", stalePanels.banner && stalePanels.panels > 0 && stalePanels.stale === stalePanels.panels, JSON.stringify(stalePanels));
    const staleRep = await openReport(p, jobA);
    check("stale run: report section says out of date; printing stays off", staleRep.includes("Out of date: your records changed after this explanation was written") && !(await printable(p)));
    const reStale = await api(p, `/api/matches/${runA.runId}/explanations`, "POST");
    check("stale run: asking again is refused, no new generation", reStale.s >= 400 && (await stored(runA.runId))?.attempts === 1, String(reStale.s));

    // D. A technician with no records: nothing positive is generated.
    const t2 = await newTech("b");
    const jobD = await importJob(t2.p, "Fictional Mini-Split Installer (explain test)");
    const runD = await evaluateAndSave(t2.workerId, jobD);
    const xd = await api(t2.p, `/api/matches/${runD.runId}/explanations`, "POST");
    const dItems = (xd.j?.explanations?.items ?? []) as { kind: string; related: unknown[] }[];
    check("no evidence: every non-eligibility line says nothing related, no AI text", xd.s === 200 && dItems.length === 6 && dItems.every((i) => (i.kind === "no_related" || i.kind === "eligibility") && i.related.length === 0), JSON.stringify(dItems.map((i) => i.kind)));
    const foreign = await api(t2.p, `/api/matches/${runA.runId}/explanations`, "POST");
    check("another technician's run is not available", foreign.s === 404, String(foreign.s));

    // E. A run made stale by a new record is refused before any generation.
    const runF = await evaluateAndSave(t2.workerId, jobD);
    await admin.from("evidence").insert(record(t2.workerId, "Another record after the run (FICTIONAL)", ["Installed condensate line"]));
    const xe = await api(t2.p, `/api/matches/${runF.runId}/explanations`, "POST");
    check("an out-of-date run is refused before any generation", xe.s >= 400 && (await stored(runF.runId)) === null, String(xe.s));
    const runE = await evaluateAndSave(t2.workerId, jobD);
    check("a current run for the new record set can be explained", runE.status === "completed" && (await api(t2.p, `/api/matches/${runE.runId}/explanations`, "POST")).s === 200);
  } catch (e) {
    check("aborted", false, (e as Error).message);
  } finally {
    check("no uncaught page errors", errors.length === 0, errors.slice(0, 2).join(" | "));
    await browser.close();
    const failed = results.filter((r) => !r).length;
    console.log(`\ne2e-import explain: ${results.length - failed}/${results.length} passed`);
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

  // "Your next steps" (sign-off and supervisor review are OFF in this phase).
  const ns = await nextStepsOnPage(p);
  check("next steps: one per gap, required first, found line omitted", JSON.stringify(ns.kinds) === JSON.stringify(EXPECTED_KINDS), JSON.stringify(ns.kinds));
  check("next steps: self-reported install+startup → upload or confirm, linking to that record", /self-reported with no supporting document/.test(ns.byKind.confirm ?? "") && ns.links.some((h) => /^\/evidence#evidence-/.test(h)));
  check("next steps: with sign-off and review off, no confirmation flow is offered", !/supervisor|customer/i.test(ns.byKind.confirm ?? ""));
  check("next steps: licence line → manual clarification with the stored reason", /Driving or licence requirements are not checked/.test(ns.byKind.manual_review ?? "") && /ask the employer to clarify/.test(ns.byKind.manual_review ?? ""));
  check("next steps: missing documents → upload one already held", /If you already hold a document/.test(ns.byKind.upload ?? ""));
  check("next steps: never implies missing ability, no courses or hiring talk", ns.text.includes("says nothing about your ability") && !BANNED.test(ns.text), (ns.text.match(BANNED) ?? [""])[0]);

  const prep = await openReport(p, pastedJob);
  const rns = await nextStepsOnPage(p);
  check("report: next steps section matches the job view", JSON.stringify(rns.kinds) === JSON.stringify(EXPECTED_KINDS), JSON.stringify(rns.kinds));
  await p.emulateMediaType("print");
  const printView = await p.evaluate(() => {
    const sec = document.querySelector("[data-section=next-steps]") as HTMLElement | null;
    const links = [...(sec?.querySelectorAll("a") ?? [])] as HTMLElement[];
    return { shown: !!sec && sec.offsetParent !== null, linksHidden: links.length > 0 && links.every((a) => a.offsetParent === null) };
  });
  await p.emulateMediaType("screen");
  check("report: next steps print, with on-screen links left out of the printout", printView.shown && printView.linksHidden, JSON.stringify(printView));
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
