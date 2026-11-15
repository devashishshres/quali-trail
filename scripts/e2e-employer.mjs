// Employer review portal: real browser journeys against the ISOLATED LOCAL stack (app on :3100 with
// EMPLOYER_REVIEW_ENABLED=true, SUPERVISOR_REVIEW_ENABLED=true, EMAIL_MODE=mock; Supabase on :54321; Mailpit on :54324).
// All identities are fictional. The match report is seeded directly, so no memory or model provider is called.
//   E2E_APP_DIR=<dir the app runs from> E2E_SERVER_LOG=<its log file> node scripts/e2e-employer.mjs
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import puppeteer from "puppeteer-core";
import { createClient } from "@supabase/supabase-js";

const APP = process.env.E2E_APP_URL ?? "http://localhost:3100";
const MAILPIT = process.env.E2E_MAILPIT_URL ?? "http://127.0.0.1:54324";
const APP_DIR = process.env.E2E_APP_DIR ?? process.cwd();
const OUTBOX = join(APP_DIR, ".signoff-outbox/outbox.jsonl");
const SHOTS = process.env.E2E_SHOTS ?? join(tmpdir(), "qualitrail-employer-shots");
const SERVER_LOG = process.env.E2E_SERVER_LOG;
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const host = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://x.invalid").hostname;
if (host !== "127.0.0.1" && host !== "localhost") throw new Error("e2e-employer only runs against a LOCAL Supabase stack");
mkdirSync(SHOTS, { recursive: true });

const run = randomUUID().slice(0, 6);
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => createHash("sha256").update(s).digest("hex");
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const must = (r, what) => { if (r.error) throw new Error(`${what}: ${r.error.code ?? r.error.message}`); return r.data; };

async function waitFor(fn, ms = 15000, step = 400) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn().catch(() => null); if (v) return v; await sleep(step); }
  return null;
}
async function confirmLink(email) {
  return waitFor(async () => {
    const s = await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)).json();
    const id = s.messages?.[0]?.ID; if (!id) return null;
    const m = await (await fetch(`${MAILPIT}/api/v1/message/${id}`)).json();
    return (m.Text || m.HTML || "").match(/https?:\/\/[^\s"<>]+\/auth\/v1\/verify[^\s"<>]+/)?.[0]?.replace(/&amp;/g, "&") ?? null;
  });
}
function outbox(kind, to) {
  if (!existsSync(OUTBOX)) return null;
  return readFileSync(OUTBOX, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((m) => m.meta?.kind === kind && m.to === to).at(-1) ?? null;
}
const text = (p) => p.evaluate(() => document.body.innerText);
const shot = (p, name) => p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
async function clickText(p, label, sel = "button, a") {
  const ok = await p.evaluate((label, sel) => {
    const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.trim() === label && !e.disabled);
    if (el) { el.scrollIntoView(); el.click(); return true; } return false;
  }, label, sel);
  if (!ok) throw new Error(`no clickable "${label}"`);
}
async function tickLabel(p, contains) {
  const ok = await p.evaluate((t) => {
    const l = [...document.querySelectorAll("label")].find((x) => x.innerText.includes(t));
    const i = l?.querySelector("input[type=checkbox], input[type=radio]");
    if (!i) return false; i.scrollIntoView(); i.click(); return true;
  }, contains);
  if (!ok) throw new Error(`no checkbox labelled "${contains}"`);
}
async function fill(p, selector, value) { await p.$eval(selector, (el) => { el.value = ""; }); await p.type(selector, value); }
const api = (p, path, init) => p.evaluate(async (path, init) => { const r = await fetch(path, init); return { status: r.status, body: await r.json().catch(() => null) }; }, path, init ?? {});

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
const pageErrors = [];
const pages = [];
async function persona(name) {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  pages.push([name, p]);
  p.setDefaultTimeout(20000);
  p.on("pageerror", (e) => pageErrors.push(`${name}: ${e.message}`));
  return p;
}
async function signIn(p, email, password, landing) {
  await p.goto(`${APP}/sign-in`, { waitUntil: "networkidle0" });
  await fill(p, "input[name=email]", email); await fill(p, "input[name=password]", password);
  await clickText(p, "Sign in");
  await p.waitForFunction((l) => location.pathname === l, {}, landing);
}

const sentTokens = [];
try {
  await admin.from("signoff_rate_limits").delete().neq("key_hash", ""); // local stack only: clean limiter for reruns
  const pw = `Pw-${randomUUID()}`;

  /* ------------------------------------------------------------ fictional technician, records and supervisor */
  const techEmail = `tess.${run}@test.qualitrail.dev`;
  const tech = must(await admin.auth.admin.createUser({ email: techEmail, password: pw, email_confirm: true }), "tech user").user;
  const worker = must(await admin.from("workers").insert({ auth_user_id: tech.id, name: `Tess Tech ${run} (fictional)`, trade: "HVAC", is_synthetic: true }).select("id").single(), "worker");
  const pdf = readFileSync(process.env.E2E_FICTIONAL_PDF ?? join(APP_DIR, "..", "fictional-test-record.pdf"));
  const recA = randomUUID(), recB = randomUUID();
  must(await admin.storage.from("evidence").upload(`${tech.id}/${recA}.pdf`, pdf, { contentType: "application/pdf" }), "upload");
  const base = { worker_id: worker.id, type: "work_record", source_date: "2026-11-02", issuer: "Fictional Mechanical", verification_status: "self_reported", index_status: "failed", index_error: "Fixture: not indexed (no memory provider locally)" };
  must(await admin.from("evidence").insert([
    { ...base, id: recA, title: `Heat-pump install ${run}`, source_kind: "pdf_upload", storage_path: `${tech.id}/${recA}.pdf`, mime_type: "application/pdf", file_hash: sha(pdf.toString("base64")),
      structured_data: { activities: ["Brazed line set", "Pulled vacuum to 500 microns"], equipment: ["3-ton heat pump"], skills: ["Brazing"], summary: "Customer Pat Example at 12 Fictional Lane" } },
    { ...base, id: recB, title: `Furnace tune-up ${run}`, source_kind: "manual_text", storage_path: null, file_hash: sha(recB),
      structured_data: { activities: ["Checked heat exchanger"], equipment: ["80k BTU furnace"], skills: [] } },
  ]), "evidence");

  const supEmail = `sky.${run}@test.qualitrail.dev`;
  const sup = must(await admin.auth.admin.createUser({ email: supEmail, password: pw, email_confirm: true }), "sup user").user;
  must(await admin.rpc("account_onboard_supervisor", { p_auth: sup.id, p_name: `Sky Reviewer ${run} (fictional)`, p_org: "Fictional Mechanical", p_title: "Lead installer" }), "sup profile");
  const t = `tok-${randomUUID()}`;
  must(await admin.rpc("sup_invite_create", { p_worker: worker.id, p_email: supEmail, p_email_hash: sha(`e-${supEmail}`), p_hint: "s***", p_token_hash: sha(t), p_valid_days: 14 }), "sup invite");
  const rel = must(await admin.rpc("sup_invite_answer", { p_token_hash: sha(t), p_auth: sup.id, p_accept: true }), "sup accept").relationshipId;
  const revA = must(await admin.rpc("review_create", { p_worker: worker.id, p_evidence: recA, p_relationship: rel, p_valid_days: 30, p_share_original: false }), "review A").id;
  const revB = must(await admin.rpc("review_create", { p_worker: worker.id, p_evidence: recB, p_relationship: rel, p_valid_days: 30, p_share_original: false }), "review B").id;

  /* ------------------------------------------------------------ supervisor confirms A WITH consent (UI), B without */
  const S = await persona("supervisor");
  await signIn(S, supEmail, pw, "/supervisor");
  await S.goto(`${APP}/supervisor/reviews/${revA}`, { waitUntil: "networkidle0" });
  await tickLabel(S, "I personally observed some or all");
  await sleep(300);
  await tickLabel(S, "Brazed line set");
  await tickLabel(S, "I personally observed this technician");
  const consentText = await text(S);
  check("supervisor sees the optional employer-sharing consent (feature on)", consentText.includes("Optional: let employers see who confirmed this"));
  await tickLabel(S, "Optional: let employers see who confirmed this");
  await S.type("textarea[name=comment]", `Private comment ${run}`);
  await shot(S, "e01-supervisor-consent");
  await clickText(S, "Submit answer");
  await S.waitForFunction(() => !document.querySelector("form textarea[name=comment]"));
  const noConsent = await api(S, `/api/supervisor/reviews/${revB}/respond`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision: "confirm_observed", observedTasks: ["Checked heat exchanger"], agreed: true }) });
  check("second confirmation recorded without consent", noConsent.status === 200 && noConsent.body.shareConsent === false);
  const { data: consents } = await admin.from("review_share_consents").select("request_id").in("request_id", [revA, revB]);
  check("exactly one consent row, for the ticked review", consents.length === 1 && consents[0].request_id === revA);

  /* ------------------------------------------------------------ a CURRENT report (seeded after the reviews) */
  const opp = must(await admin.from("opportunities").insert({ worker_id: worker.id, title: `Fictional Heat Pump Installer ${run}`, employer: "Fictional Air Co", source_url: "https://jobs.example.com/fictional", is_synthetic: true }).select("id").single(), "opp");
  const reqs = must(await admin.from("requirements").insert([
    { opportunity_id: opp.id, position: 0, original_text: "Heat pump installation experience", mandatory: true, source: "Fictional listing",
      criteria_json: { acceptedTypes: ["work_record"], supportingTypes: [], keywords: ["heat pump"], retrievalQuery: "heat pump installation", requiredFields: [] } },
    { opportunity_id: opp.id, position: 1, original_text: "Furnace maintenance", mandatory: false, source: "Fictional listing",
      criteria_json: { acceptedTypes: ["work_record"], supportingTypes: [], keywords: ["furnace"], retrievalQuery: "furnace maintenance", requiredFields: [] } },
  ]).select("id, position"), "reqs").sort((a, b) => a.position - b.position);
  const { data: wrev } = await admin.from("workers").select("evidence_revision").eq("id", worker.id).single();
  const mrun = must(await admin.from("match_runs").insert({ worker_id: worker.id, opportunity_id: opp.id, evidence_revision: wrev.evidence_revision, status: "completed", completed_at: new Date().toISOString() }).select("id").single(), "run");
  must(await admin.from("requirement_results").insert([
    { match_run_id: mrun.id, requirement_id: reqs[0].id, assessment: "evidence_found", explanation: `Narrative ${run}` },
    { match_run_id: mrun.id, requirement_id: reqs[1].id, assessment: "needs_review", explanation: "" },
  ]), "results");
  must(await admin.from("evidence_matches").insert([
    { match_run_id: mrun.id, worker_id: worker.id, requirement_id: reqs[0].id, evidence_id: recA, role: "direct", contribution: "c", relevance_explanation: `AI text ${run}` },
    { match_run_id: mrun.id, worker_id: worker.id, requirement_id: reqs[1].id, evidence_id: recB, role: "supporting", contribution: "c", relevance_explanation: "" },
  ]), "matches");
  // Seeding wrote rows that mark runs stale; this fixture report stands in for a fresh matching run.
  must(await admin.from("match_runs").update({ status: "completed" }).eq("id", mrun.id), "run current");

  /* ------------------------------------------------------------ technician previews and shares */
  const reviewerEmail = `hiring.${run}@employer.example`; // NOT on the local sign-up allowlist
  const W = await persona("technician");
  await signIn(W, techEmail, pw, "/passport");
  await W.goto(`${APP}/reports`, { waitUntil: "networkidle0" });
  await W.waitForFunction(() => document.body.innerText.includes("Share with an employer"));
  await clickText(W, "Share this report…");
  await tickLabel(W, "Also let them open the original document");
  await fill(W, "section input[type=email]", reviewerEmail);
  await clickText(W, "Preview exactly what they'll see");
  await W.waitForFunction(() => document.querySelector(".border-dashed")?.innerText.includes("Shared records"));
  const preview = await W.evaluate(() => document.querySelector(".border-dashed")?.innerText ?? "");
  check("preview names the consenting supervisor, withholds the other", preview.includes(`Sky Reviewer ${run} (fictional)`) && preview.includes("A supervisor (details not shared)"));
  check("preview has no comments, customer details, summaries or AI text", !preview.includes(`Private comment ${run}`) && !preview.includes("Pat Example") && !preview.includes("Fictional Lane") && !preview.includes(`AI text ${run}`) && !preview.includes(`Narrative ${run}`));
  await shot(W, "e02-technician-preview");
  await tickLabel(W, "I've reviewed exactly what will be shared");
  await clickText(W, "Share");
  await W.waitForFunction(() => document.body.innerText.includes("Shared with"));
  const { data: shareRow } = await admin.from("employer_shares").select("id, status, packet, invited_email").eq("worker_id", worker.id).single();
  check("share stored pending with a frozen packet", shareRow.status === "pending" && shareRow.packet.records.length === 2);
  check("stored packet equals what the preview showed", JSON.stringify(shareRow.packet).includes(`Sky Reviewer ${run}`) && !JSON.stringify(shareRow.packet).includes(`Private comment ${run}`));

  const mail = await waitFor(async () => outbox("employer_share_invitation", reviewerEmail));
  const link = mail?.text.match(/https?:\/\/\S+#t=[A-Za-z0-9_-]+/)?.[0];
  sentTokens.push(link?.split("#t=")[1]);
  check("simulated invitation sent, no packet content in the email", mail && mail.subject.startsWith("[SIMULATED]") && !!link && !mail.text.includes("Heat-pump install") && !mail.text.includes("Brazed"));
  check("email never calls access identity verification", mail && mail.text.includes("does not verify your identity"));

  /* ------------------------------------------------------------ forwarded link: another signed-in account */
  const fwdEmail = `forwarded.${run}@test.qualitrail.dev`;
  must(await admin.auth.admin.createUser({ email: fwdEmail, password: pw, email_confirm: true }), "fwd user");
  const F = await persona("forwarded");
  await signIn(F, fwdEmail, pw, "/onboarding");
  await F.goto(link, { waitUntil: "networkidle0" });
  await F.waitForFunction(() => document.body.innerText.includes("Open the packet"));
  await clickText(F, "Open the packet");
  await F.waitForFunction(() => document.body.innerText.includes("different email address"));
  check("forwarded link refused for a different account", (await text(F)).includes("different email address"));
  const fwdRead = await api(F, `/api/employer/shares/${shareRow.id}`);
  check("different account cannot read the packet by id", fwdRead.status === 404);

  /* ------------------------------------------------------------ invited reviewer registers and opens */
  const R = await persona("reviewer");
  await R.goto(link, { waitUntil: "networkidle0" });
  await R.waitForFunction(() => document.body.innerText.includes("Create an account"));
  const gate = await text(R);
  check("invitation page shows no packet content before sign-in", !gate.includes("Heat-pump install") && !gate.includes("Brazed") && gate.includes("does not verify your identity"));
  check("token removed from the address bar", !(await R.url()).includes("#t="));
  await clickText(R, "Create an account");
  await R.waitForSelector("input[name=confirm]");
  await fill(R, "input[name=email]", reviewerEmail); await fill(R, "input[name=password]", pw); await fill(R, "input[name=confirm]", pw);
  await clickText(R, "Create account");
  await R.waitForFunction(() => document.body.innerText.includes("Check your email"));
  const confirm = await confirmLink(reviewerEmail);
  check("an address with an open share may register (not on the allowlist)", !!confirm);
  await R.goto(confirm, { waitUntil: "networkidle0" });
  await R.waitForFunction(() => location.pathname === "/invite/employer");
  await R.waitForFunction(() => document.body.innerText.includes("Open the packet"));
  await clickText(R, "Open the packet");
  await R.waitForFunction(() => location.pathname.startsWith("/employer/"));
  await R.waitForFunction(() => document.body.innerText.includes("Shared records"));
  const view = await text(R);
  await shot(R, "e03-employer-packet");
  check("reviewer sees the packet read-only", view.includes(`Tess Tech ${run} (fictional)`) && view.includes("Heat pump installation experience") && view.includes(`Sky Reviewer ${run} (fictional)`));
  check("reviewer view has no comment, customer, AI text or reviewer email", !view.includes(`Private comment ${run}`) && !view.includes("Pat Example") && !view.includes(`AI text ${run}`) && !view.includes(supEmail));
  check("reviewer view has no edit or decision controls", !(await R.$("form, textarea, input[type=email]")));

  const docOk = await api(R, `/api/employer/shares/${shareRow.id}/document?record=${recA}`);
  const fileStatus = docOk.body?.url ? (await fetch(docOk.body.url)).status : 0;
  check("shared original opens via a short-lived link", docOk.status === 200 && fileStatus === 200);
  const docNo = await api(R, `/api/employer/shares/${shareRow.id}/document?record=${recB}`);
  check("an unshared original is refused", docNo.status === 404);

  const me = await api(R, "/api/me");
  check("reviewer account has no technician or supervisor role and can't create one", me.body.worker === null && me.body.supervisor === null && !me.body.canOnboardWorker && !me.body.canOnboardSupervisor);
  for (const [path, what] of [["/api/employer-shares", "technician shares"], ["/api/supervisor/dashboard", "supervisor dashboard"], ["/api/evidence", "evidence"]]) {
    const r = await api(R, path);
    check(`reviewer has no access to ${what}`, r.status === 401 || r.status === 403 || r.status === 404, `status ${r.status}`);
  }
  await R.goto(`${APP}/passport`, { waitUntil: "networkidle0" });
  check("worker pages redirect the reviewer away", !(await R.url()).includes("/passport"));

  /* ------------------------------------------------------------ technician sees access, edits, withdraws */
  await W.goto(`${APP}/reports`, { waitUntil: "networkidle0" });
  await W.waitForFunction(() => document.body.innerText.includes("Viewed 1 time"));
  check("technician sees it was opened and viewed", (await text(W)).includes("Opened") && (await text(W)).includes("originals opened 1"));
  must(await admin.from("evidence").update({ title: `Heat-pump install ${run} (edited)` }).eq("id", recB), "edit");
  await R.goto(`${APP}/employer/${shareRow.id}`, { waitUntil: "networkidle0" });
  await R.waitForFunction(() => document.body.innerText.includes("since sharing"));
  const after = await text(R);
  check("edit after sharing is flagged; the packet itself is unchanged", after.includes("edited or removed 1") && !after.includes("(edited)"));
  await clickText(W, "Withdraw");
  await W.waitForFunction(() => document.body.innerText.includes("Withdrawn"));
  await R.goto(`${APP}/employer/${shareRow.id}`, { waitUntil: "networkidle0" });
  await R.waitForFunction(() => document.body.innerText.includes("withdrew"));
  check("withdrawal ends access immediately", (await text(R)).includes("withdrew"));
  const docAfter = await api(R, `/api/employer/shares/${shareRow.id}/document?record=${recA}`);
  check("withdrawal ends original access", docAfter.status === 404);

  const { data: events } = await admin.from("employer_share_events").select("event").eq("share_id", shareRow.id).order("id");
  check("access log", JSON.stringify(events.map((e) => e.event)) === JSON.stringify(["invited", "accepted", "viewed", "original_opened", "viewed", "revoked"]), events.map((e) => e.event).join(","));
  check("no browser page errors", pageErrors.length === 0, pageErrors.join(" | "));

  if (SERVER_LOG) {
    const log = readFileSync(SERVER_LOG, "utf8");
    const leaks = [reviewerEmail, supEmail, ...sentTokens.filter(Boolean), "token=", "/object/sign/"].filter((s) => log.includes(s));
    check("server log has no addresses, invitation tokens or signed URLs", leaks.length === 0, leaks.length ? `${leaks.length} leak(s)` : "");
  }
} catch (e) {
  check("journey completed", false, e instanceof Error ? e.message : String(e));
  for (const [name, p] of pages) await shot(p, `failure-${name}`).catch(() => undefined);
} finally {
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots: ${SHOTS}`);
  process.exit(failed.length ? 1 : 0);
}
