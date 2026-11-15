// Employer review portal: real browser journeys against the ISOLATED LOCAL stack (app on :3100 with
// EMPLOYER_REVIEW_ENABLED=true, SUPERVISOR_REVIEW_ENABLED=true, EMAIL_MODE=mock; Supabase on :54321; Mailpit on :54324).
// All identities are fictional. Records are seeded directly; no job import, matching, memory or model provider is used.
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
  const [recA, recB, recC, cert, cert2, train] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  for (const id of [recA, cert, cert2, train]) must(await admin.storage.from("evidence").upload(`${tech.id}/${id}.pdf`, pdf, { contentType: "application/pdf" }), "upload");
  const base = { worker_id: worker.id, source_date: "2026-11-02", issuer: "Fictional Mechanical", verification_status: "self_reported", index_status: "failed", index_error: "Fixture: not indexed (no memory provider locally)" };
  const file = (id) => ({ source_kind: "pdf_upload", storage_path: `${tech.id}/${id}.pdf`, mime_type: "application/pdf", file_hash: sha(`${id}-${pdf.length}`) });
  must(await admin.from("evidence").insert([
    { ...base, ...file(recA), id: recA, type: "work_record", title: `Heat-pump install ${run}`,
      structured_data: { activities: ["Brazed line set", "Pulled vacuum to 500 microns"], equipment: ["3-ton heat pump"], skills: ["Brazing"], summary: "Customer Pat Example at 12 Fictional Lane" } },
    { ...base, id: recB, type: "work_record", title: `Furnace tune-up ${run}`, source_kind: "manual_text", storage_path: null, file_hash: sha(recB),
      structured_data: { activities: ["Checked heat exchanger"], equipment: ["80k BTU furnace"], skills: [] } },
    { ...base, id: recC, type: "work_record", title: `Older private job ${run}`, source_kind: "manual_text", storage_path: null, file_hash: sha(recC),
      structured_data: { activities: ["Replaced capacitor"], equipment: [], skills: [] } },
    { ...base, ...file(cert), id: cert, type: "certification", title: `EPA 608 Universal ${run}`, issuer: "Fictional Institute", verification_status: "document_supplied",
      structured_data: { credentialNumber: `CRED-${run}-SECRET`, holder: "Tess Tech, born 1990-01-01" } },
    { ...base, ...file(cert2), id: cert2, type: "certification", title: `NATE Heat Pump ${run}`, issuer: "Fictional Board", verification_status: "document_supplied", structured_data: {} },
    { ...base, ...file(train), id: train, type: "training", title: `Training course ${run}`, structured_data: {} },
  ]), "evidence");

  const supEmail = `sky.${run}@test.qualitrail.dev`;
  const sup = must(await admin.auth.admin.createUser({ email: supEmail, password: pw, email_confirm: true }), "sup user").user;
  must(await admin.rpc("account_onboard_supervisor", { p_auth: sup.id, p_name: `Sky Reviewer ${run} (fictional)`, p_org: "Fictional Mechanical", p_title: "Lead installer" }), "sup profile");
  const t = `tok-${randomUUID()}`;
  must(await admin.rpc("sup_invite_create", { p_worker: worker.id, p_email: supEmail, p_email_hash: sha(`e-${supEmail}`), p_hint: "s***", p_token_hash: sha(t), p_valid_days: 14 }), "sup invite");
  const rel = must(await admin.rpc("sup_invite_answer", { p_token_hash: sha(t), p_auth: sup.id, p_accept: true }), "sup accept").relationshipId;
  const review = async (ev) => must(await admin.rpc("review_create", { p_worker: worker.id, p_evidence: ev, p_relationship: rel, p_valid_days: 30, p_share_original: false }), "review").id;
  const [revA, revB, revC] = [await review(recA), await review(recB), await review(recC)];

  /* ------------------------------------------------------------ supervisor: A shared WITH name (UI), B shared without name, C private */
  const S = await persona("supervisor");
  await signIn(S, supEmail, pw, "/supervisor");
  await S.goto(`${APP}/supervisor/reviews/${revA}`, { waitUntil: "networkidle0" });
  await tickLabel(S, "I personally observed some or all");
  await sleep(300);
  await tickLabel(S, "Brazed line set");
  await tickLabel(S, "I personally observed this technician");
  check("supervisor sees separate share and name permissions, both unticked", await S.evaluate(() => {
    const a = document.querySelector("input[name=shareWithEmployers]"), b = document.querySelector("input[name=shareName]");
    return !!a && !!b && !a.checked && !b.checked && b.disabled;
  }));
  await tickLabel(S, "include this confirmation in records they choose to share");
  await sleep(200);
  await tickLabel(S, "Also show my name, organization and title");
  await S.type("textarea[name=comment]", `Private comment ${run}`);
  await shot(S, "e01-supervisor-consent");
  await clickText(S, "Submit answer");
  await S.waitForFunction(() => !document.querySelector("form textarea[name=comment]"));
  const respond = (id, extra) => api(S, `/api/supervisor/reviews/${id}/respond`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision: "confirm_observed", observedTasks: ["Checked heat exchanger"], agreed: true, ...extra }) });
  const rb = await respond(revB, { shareWithEmployers: true });
  const rc = await respond(revC, { shareName: true, observedTasks: ["Replaced capacitor"] }); // name without share means nothing
  check("share-only and no-permission confirmations recorded", rb.body?.shareConsent === true && rc.body?.shareConsent === false, `${rb.status} ${JSON.stringify(rb.body)?.slice(0, 120)} / ${rc.status} ${JSON.stringify(rc.body)?.slice(0, 120)}`);
  const { data: consents } = await admin.from("review_share_consents").select("request_id, show_name").in("request_id", [revA, revB, revC]);
  const cmap = Object.fromEntries(consents.map((c) => [c.request_id, c.show_name]));
  check("permission rows: A named, B anonymous, C none", cmap[revA] === true && cmap[revB] === false && !(revC in cmap));

  /* ------------------------------------------------------------ technician picks items and previews (no job import or matching) */
  const reviewerEmail = `hiring.${run}@employer.example`; // NOT on the local sign-up allowlist
  const W = await persona("technician");
  await signIn(W, techEmail, pw, "/passport");
  await W.goto(`${APP}/share`, { waitUntil: "networkidle0" });
  await W.waitForFunction(() => document.body.innerText.includes("Uploaded certifications"));
  const picker = await text(W);
  check("picker lists the two shareable jobs and both certificates, nothing preselected",
    picker.includes(`Heat-pump install ${run}`) && picker.includes(`Furnace tune-up ${run}`) && picker.includes(`EPA 608 Universal ${run}`) && picker.includes(`NATE Heat Pump ${run}`)
    && (await W.$$eval("input[type=checkbox]:checked", (x) => x.length)) === 0);
  check("unpermitted job and training record are not offered; the reason is explained",
    !picker.includes(`Older private job ${run}`) && !picker.includes(`Training course ${run}`) && picker.includes("without permission to share outside QualiTrail"), process.env.E2E_DEBUG ? picker.slice(0, 1500) : "");
  await tickLabel(W, `Heat-pump install ${run}`);
  await tickLabel(W, `Furnace tune-up ${run}`);
  await tickLabel(W, `EPA 608 Universal ${run}`);
  await sleep(200);
  await tickLabel(W, "Also allow them to open the original certificate file");
  await fill(W, "input[type=email]", reviewerEmail);
  await clickText(W, "Preview exactly what they'll see");
  await W.waitForSelector("[data-preview]");
  await W.waitForFunction(() => document.querySelector("[data-preview]")?.innerText.length > 50);
  const preview = await W.evaluate(() => document.querySelector("[data-preview]").innerText);
  const pageNow = await text(W);
  check("personal-information warning shown for the original certificate", pageNow.includes("Original certificates may contain personal information"));
  check("preview names the supervisor who allowed it, and honestly withholds the other name",
    preview.includes(`Sky Reviewer ${run} (fictional)`) && preview.includes("did not permit their name to be shown"));
  check("preview has only the selected items", preview.includes(`EPA 608 Universal ${run}`) && !preview.includes(`NATE Heat Pump ${run}`) && !preview.includes(`Older private job ${run}`) && !preview.includes(`Training course ${run}`));
  check("preview has no comments, customer details, credential numbers, summaries or equipment",
    !/Private comment|Pat Example|Fictional Lane|CRED-|born 1990|3-ton heat pump|80k BTU/.test(preview));
  await shot(W, "e02-technician-preview");
  await tickLabel(W, "I've reviewed exactly what will be shared");
  await clickText(W, "Share", "form button.btn-primary");
  await W.waitForFunction(() => document.body.innerText.includes("What you've shared") && document.body.innerText.includes("1 certification"));
  const { data: shareRow } = await admin.from("employer_shares").select("id, status, packet, shared_records").eq("worker_id", worker.id).single();
  const pj = JSON.stringify(shareRow.packet);
  check("share stored pending with a frozen packet of exactly the selection",
    shareRow.status === "pending" && shareRow.packet.work.length === 2 && shareRow.packet.certifications.length === 1
    && shareRow.shared_records.filter((r) => r.original).map((r) => r.id).join() === cert);
  check("stored packet has no excluded fields", pj.includes(`Sky Reviewer ${run}`) && !/Private comment|Pat Example|CRED-|summary|explanation|requirement|opportunit/.test(pj));

  const mail = await waitFor(async () => outbox("employer_share_invitation", reviewerEmail));
  const link = mail?.text.match(/https?:\/\/\S+#t=[A-Za-z0-9_-]+/)?.[0];
  sentTokens.push(link?.split("#t=")[1]);
  check("simulated invitation sent, no packet content in the email", mail && mail.subject.startsWith("[SIMULATED]") && !!link && !mail.text.includes("Heat-pump install") && !mail.text.includes("EPA 608"));
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
  check("different account cannot read the packet or an original by id",
    (await api(F, `/api/employer/shares/${shareRow.id}`)).status === 404 && (await api(F, `/api/employer/shares/${shareRow.id}/document?record=${cert}`)).status === 404);

  /* ------------------------------------------------------------ invited reviewer registers and opens */
  const R = await persona("reviewer");
  await R.goto(link, { waitUntil: "networkidle0" });
  await R.waitForFunction(() => document.body.innerText.includes("Create an account"));
  const gate = await text(R);
  check("invitation page shows no packet content before sign-in", !gate.includes("Heat-pump install") && !gate.includes("EPA 608") && gate.includes("does not verify your identity"));
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
  await R.waitForFunction(() => document.body.innerText.includes("Certifications"));
  const view = await text(R);
  await shot(R, "e03-employer-packet");
  check("reviewer sees the shared work and certificate read-only",
    view.includes(`Tess Tech ${run} (fictional)`) && view.includes(`Heat-pump install ${run}`) && view.includes(`EPA 608 Universal ${run}`) && view.includes(`Sky Reviewer ${run} (fictional)`));
  check("reviewer view has nothing unselected or excluded",
    !view.includes(`NATE Heat Pump ${run}`) && !view.includes(`Older private job ${run}`) && !view.includes(`Training course ${run}`)
    && !/Private comment|Pat Example|Fictional Lane|CRED-|born 1990|3-ton heat pump/.test(view) && !view.includes(supEmail) && !view.includes(techEmail));
  check("reviewer view has no edit or decision controls", !(await R.$("form, textarea, input[type=email]")));

  const docOk = await api(R, `/api/employer/shares/${shareRow.id}/document?record=${cert}`);
  const fileStatus = docOk.body?.url ? (await fetch(docOk.body.url)).status : 0;
  check("the authorized certificate original opens via a short-lived link", docOk.status === 200 && fileStatus === 200);
  for (const [rec, what] of [[recA, "a work document"], [cert2, "an unselected certificate"], [train, "a training record"], [recC, "an unshared job"]]) {
    check(`original refused: ${what}`, (await api(R, `/api/employer/shares/${shareRow.id}/document?record=${rec}`)).status === 404);
  }

  const me = await api(R, "/api/me");
  check("reviewer account has no technician or supervisor role and can't create one", me.body.worker === null && me.body.supervisor === null && !me.body.canOnboardWorker && !me.body.canOnboardSupervisor);
  for (const [path, what] of [["/api/employer-shares", "technician shares"], ["/api/employer-shares/candidates", "technician records"], ["/api/supervisor/dashboard", "supervisor dashboard"], ["/api/evidence", "evidence"]]) {
    const r = await api(R, path);
    check(`reviewer has no access to ${what}`, r.status === 401 || r.status === 403 || r.status === 404, `status ${r.status}`);
  }
  await R.goto(`${APP}/passport`, { waitUntil: "networkidle0" });
  check("worker pages redirect the reviewer away", !(await R.url()).includes("/passport"));

  /* ------------------------------------------------------------ technician sees access, edits, withdraws */
  await W.goto(`${APP}/share`, { waitUntil: "networkidle0" });
  await W.waitForFunction(() => document.body.innerText.includes("Viewed 1 time"));
  check("technician sees it was opened, viewed and the original opened", (await text(W)).includes("Opened") && (await text(W)).includes("originals opened 1"));
  must(await admin.from("evidence").update({ title: `Heat-pump install ${run} (edited)` }).eq("id", recA), "edit");
  await R.goto(`${APP}/employer/${shareRow.id}`, { waitUntil: "networkidle0" });
  await R.waitForFunction(() => document.body.innerText.includes("since sharing"));
  const after = await text(R);
  check("edit after sharing is flagged; the packet itself is unchanged", after.includes("edited or removed 1") && !after.includes("(edited)"));
  await clickText(W, "Withdraw");
  await W.waitForFunction(() => document.body.innerText.includes("Withdrawn"));
  await R.goto(`${APP}/employer/${shareRow.id}`, { waitUntil: "networkidle0" });
  await R.waitForFunction(() => document.body.innerText.includes("withdrew"));
  check("withdrawal ends access immediately", (await text(R)).includes("withdrew"));
  check("withdrawal ends original access", (await api(R, `/api/employer/shares/${shareRow.id}/document?record=${cert}`)).status === 404);

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
