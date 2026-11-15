// Real browser journeys against the ISOLATED LOCAL stack (app on :3100, Supabase on :54321, Mailpit on :54324).
// All identities are fictional (@test.qualitrail.dev / @example.test). Nothing here touches a hosted service.
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
//
// Usage (see README, "Local browser journeys"): start the local stack, build and start the app on :3100 with
// the local-only environment, then:
//   E2E_APP_DIR=<dir the app runs from> E2E_SERVER_LOG=<its log file> node scripts/e2e-local.mjs
import { join } from "node:path";
import { tmpdir } from "node:os";
import puppeteer from "puppeteer-core";
import { createClient } from "@supabase/supabase-js";

const APP = process.env.E2E_APP_URL ?? "http://localhost:3100";
const MAILPIT = process.env.E2E_MAILPIT_URL ?? "http://127.0.0.1:54324";
const APP_DIR = process.env.E2E_APP_DIR ?? process.cwd();
const OUTBOX = join(APP_DIR, ".signoff-outbox/outbox.jsonl");
const SHOTS = process.env.E2E_SHOTS ?? join(tmpdir(), "qualitrail-e2e-shots");
const SERVER_LOG = process.env.E2E_SERVER_LOG;
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const host = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://x.invalid").hostname;
if (host !== "127.0.0.1" && host !== "localhost") throw new Error("e2e-local only runs against a LOCAL Supabase stack");
mkdirSync(SHOTS, { recursive: true });
const run = randomUUID().slice(0, 6);
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });

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
  const rows = readFileSync(OUTBOX, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((m) => m.meta?.kind === kind && m.to === to);
  return rows.at(-1) ?? null;
}
const linkIn = (m) => m?.text.match(/https?:\/\/\S+#t=[A-Za-z0-9_-]+/)?.[0];
const codeIn = (m) => m?.text.match(/Code: (\d{6})/)?.[1];
const text = (p) => p.evaluate(() => document.body.innerText);
async function shot(p, name) { await p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }); }
async function clickText(p, label, sel = "button, a") {
  const ok = await p.evaluate((label, sel) => {
    const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.trim() === label && !e.disabled);
    if (el) { el.scrollIntoView(); el.click(); return true; } return false;
  }, label, sel);
  if (!ok) throw new Error(`no clickable "${label}"`);
}
async function fill(p, selector, value) { await p.$eval(selector, (el) => { el.value = ""; }); await p.type(selector, value); }

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
const consoleErrors = [];
async function persona(name) {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  p.setDefaultTimeout(20000);
  p.on("pageerror", (e) => consoleErrors.push(`${name}: ${e.message}`));
  return p;
}
async function signUp(p, email, password, next) {
  await p.goto(`${APP}/sign-up${next ? `?next=${encodeURIComponent(next)}` : ""}`, { waitUntil: "networkidle0" });
  await fill(p, "input[name=email]", email);
  await fill(p, "input[name=password]", password);
  await fill(p, "input[name=confirm]", password);
  await clickText(p, "Create account");
  await p.waitForFunction(() => document.body.innerText.includes("Check your email"));
  const link = await confirmLink(email);
  if (!link) throw new Error(`no confirmation email for ${email}`);
  await p.goto(link, { waitUntil: "networkidle0" });
}

try {
  // LOCAL stack only: reset the persistent rate limiter so a rerun starts clean.
  await admin.from("signoff_rate_limits").delete().neq("key_hash", "");
  /* ---------------------------------------------------------------- existing account (seeded like the demo) */
  const existingEmail = `existing.${run}@test.qualitrail.dev`, pw = `Pw-${randomUUID()}`;
  const ex = await admin.auth.admin.createUser({ email: existingEmail, password: pw, email_confirm: true });
  await admin.from("workers").insert({ auth_user_id: ex.data.user.id, name: `Existing Worker ${run} (fictional)`, trade: "HVAC", is_synthetic: true });
  const E = await persona("existing");
  await E.goto(`${APP}/sign-in`, { waitUntil: "networkidle0" });
  await fill(E, "input[name=email]", existingEmail); await fill(E, "input[name=password]", pw);
  await clickText(E, "Sign in");
  await E.waitForFunction(() => location.pathname === "/passport");
  check("existing worker signs in straight to Passport (no onboarding)", (await E.url()).endsWith("/passport"));

  /* ---------------------------------------------------------------- browser protections */
  for (const path of ["/sign-in", "/passport", "/signoff", "/forgot-password", "/api/me"]) {
    const r = await fetch(`${APP}${path}`, { redirect: "manual" });
    check(`anti-framing headers on ${path}`, r.headers.get("x-frame-options") === "DENY" && (r.headers.get("content-security-policy") ?? "").includes("frame-ancestors 'none'") && r.headers.get("x-content-type-options") === "nosniff");
  }
  const framed = await E.evaluate(async (app) => {
    const f = document.createElement("iframe");
    f.src = `${app}/sign-in`; // same browser, but the header forbids framing outright
    document.body.appendChild(f);
    await new Promise((r) => setTimeout(r, 1500));
    try { return f.contentDocument?.body?.innerText?.includes("Sign in") ?? false; } catch { return false; }
  }, APP);
  check("the app refuses to render inside a frame", framed === false);

  /* ---------------------------------------------------------------- not on the allowlist */
  const outsider = await persona("outsider");
  const outEmail = `outsider.${run}@not-allowed.example`;
  await outsider.goto(`${APP}/sign-up`, { waitUntil: "networkidle0" });
  await fill(outsider, "input[name=email]", outEmail); await fill(outsider, "input[name=password]", pw); await fill(outsider, "input[name=confirm]", pw);
  await clickText(outsider, "Create account");
  await outsider.waitForFunction(() => document.body.innerText.includes("Check your email"));
  await sleep(1500);
  const outMail = await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${outEmail}"`)}`)).json();
  check("non-allowlisted address gets the same answer but no account email", (outMail.messages ?? []).length === 0);
  // An account created behind the app's back still gets no profile and no loop.
  const rogueEmail = `rogue.${run}@not-allowed.example`;
  await admin.auth.admin.createUser({ email: rogueEmail, password: pw, email_confirm: true });
  await outsider.goto(`${APP}/sign-in`, { waitUntil: "networkidle0" });
  await fill(outsider, "input[name=email]", rogueEmail); await fill(outsider, "input[name=password]", pw);
  await clickText(outsider, "Sign in");
  await outsider.waitForFunction(() => location.pathname === "/onboarding");
  await outsider.waitForFunction(() => document.body.innerText.includes("Not on the preview list"));
  await outsider.goto(`${APP}/evidence`, { waitUntil: "networkidle0" });
  check("account without a profile is held at onboarding, no redirect loop", (await outsider.url()).includes("/onboarding") && (await text(outsider)).includes("Not on the preview list"));
  const rogueOnboard = await outsider.evaluate(async () => (await fetch("/api/onboarding", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role: "worker", name: "Rogue", trade: "x" }) })).status);
  check("onboarding API refuses a non-allowlisted account", rogueOnboard === 403, `status ${rogueOnboard}`);

  /* ---------------------------------------------------------------- new worker: signup -> confirm -> onboarding */
  const workerEmail = `wren.${run}@test.qualitrail.dev`;
  const W = await persona("worker");
  await signUp(W, workerEmail, pw);
  await W.waitForFunction(() => location.pathname === "/onboarding");
  check("confirmation link signs the worker in and lands on onboarding", (await W.url()).includes("/onboarding"));
  await W.waitForSelector("input[name=trade]");
  await fill(W, "form:has(input[name=trade]) input[name=name]", `Wren Test ${run} (fictional)`);
  await fill(W, "input[name=trade]", "HVAC / heat pumps");
  await W.select("select[name=arrangement]", "contractor");
  await W.click("input[name=sample]");
  await clickText(W, "Create technician profile");
  await W.waitForFunction(() => location.pathname === "/passport");
  check("worker onboarding completes and opens Passport", (await W.url()).endsWith("/passport"));
  const replay = await W.evaluate(async () => (await (await fetch("/api/onboarding", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role: "worker", name: "Changed", trade: "x", addSampleOpportunity: true }) })).json()));
  check("repeat onboarding is idempotent", replay.created === false && replay.sampleOpportunity === false);
  const { data: wrow } = await admin.from("workers").select("id, name, employment_arrangement, is_synthetic").eq("name", `Wren Test ${run} (fictional)`).single();
  const { count: evCount } = await admin.from("evidence").select("id", { count: "exact", head: true }).eq("worker_id", wrow.id);
  const { data: opps } = await admin.from("opportunities").select("title, is_synthetic").eq("worker_id", wrow.id);
  check("new worker has no invented evidence", evCount === 0);
  check("sample job only on opt-in, labelled fictional", opps.length === 1 && opps[0].title.startsWith("Sample (fictional)") && opps[0].is_synthetic);
  check("employment arrangement stored", wrow.employment_arrangement === "contractor");

  /* ---------------------------------------------------------------- log a completed job */
  await W.goto(`${APP}/evidence`, { waitUntil: "networkidle0" });
  const jobTitle = `Heat-pump install ${run}`;
  await fill(W, "form:has(textarea[name=activities]) input[name=title]", jobTitle);
  await W.$eval("form:has(textarea[name=activities]) input[name=date]", (el) => { el.value = "2026-11-10"; });
  await fill(W, "form:has(textarea[name=activities]) input[name=issuer]", "Fictional Mechanical");
  await W.type("form:has(textarea[name=activities]) textarea[name=activities]", "Brazed line set\nPulled vacuum to 500 microns\nCharged by subcooling");
  await W.type("form:has(textarea[name=activities]) textarea[name=equipment]", "3-ton heat pump");
  await clickText(W, "Save job");
  await W.waitForFunction(() => document.body.innerText.includes("Job saved"));
  await W.waitForFunction((t) => document.body.innerText.includes(t), {}, jobTitle);
  check("completed job saved and listed", (await text(W)).includes(jobTitle));
  await shot(W, "01-worker-job-saved");

  const openRecord = async (title) => {
    await W.goto(`${APP}/evidence`, { waitUntil: "networkidle0" });
    await W.evaluate((t) => { const s = [...document.querySelectorAll("summary")].find((x) => x.innerText.includes(t)); s.closest("details").open = true; s.scrollIntoView(); }, title);
    await sleep(800);
  };

  /* ---------------------------------------------------------------- customer sign-off */
  const customerEmail = `casey.${run}@example.test`;
  await openRecord(jobTitle);
  await W.waitForSelector("section[aria-label='Customer sign-off'] input[name=email]");
  await W.type("section[aria-label='Customer sign-off'] input[name=email]", customerEmail);
  await W.click("section[aria-label='Customer sign-off'] input[name=agreed]");
  await clickText(W, "Send request");
  await W.waitForFunction(() => document.body.innerText.includes("Awaiting customer"));
  check("worker sends a customer request (shown as simulated)", (await text(W)).includes("Awaiting customer (simulated)"));

  const invite = await waitFor(async () => outbox("customer_invitation", customerEmail));
  const custLink = linkIn(invite);
  check("simulated invitation written to the local outbox, marked SIMULATED, no job details", invite && invite.subject.startsWith("[SIMULATED]") && !invite.text.includes(jobTitle) && !!custLink);

  // A copied link alone: gate only.
  const copy = await persona("copied-link");
  await copy.goto(custLink, { waitUntil: "networkidle0" });
  const gateText = await text(copy);
  check("copied link shows only the gate (no job details)", gateText.includes("Email me a code") && !gateText.includes(jobTitle) && !gateText.includes("Brazed"));
  check("token removed from the address bar", !(await copy.url()).includes("#t="));
  const linkOnly = await copy.evaluate(async () => {
    const t = sessionStorage.getItem("qt-signoff-token");
    const h = { "Content-Type": "application/json", "x-signoff-token": t };
    const snap = await fetch("/api/signoff/snapshot", { method: "POST", headers: h });
    const resp = await fetch("/api/signoff/respond", { method: "POST", headers: h, body: JSON.stringify({ decision: "confirm", typedName: "Copy Cat", agreed: true }) });
    return [snap.status, resp.status];
  });
  check("link alone cannot read the snapshot or respond", linkOnly[0] === 404 && linkOnly[1] === 404, linkOnly.join(","));
  const getRespond = await copy.evaluate(async () => (await fetch("/api/signoff/respond")).status);
  check("GET never records a response", getRespond === 405, `status ${getRespond}`);

  const C = await persona("customer");
  await C.goto(custLink, { waitUntil: "networkidle0" });
  await shot(C, "02-customer-gate");
  await clickText(C, "Email me a code");
  await C.waitForSelector("input[name=code]");
  const codeMsg = await waitFor(async () => outbox("customer_code", customerEmail));
  const code = codeIn(codeMsg);
  await C.type("input[name=code]", code === "000000" ? "111111" : "000000");
  await clickText(C, "Continue");
  await C.waitForFunction(() => document.body.innerText.includes("didn't work"));
  check("wrong code is refused", true);
  await fill(C, "input[name=code]", code);
  await clickText(C, "Continue");
  await C.waitForFunction((t) => document.body.innerText.includes(t), {}, jobTitle);
  check("after the code, the customer sees the frozen snapshot", (await text(C)).includes("Brazed line set"));
  check("simulated banner visible to the customer", (await text(C)).includes("SIMULATED"));
  await shot(C, "03-customer-snapshot");
  // The code is single use (replay from the copied-link browser fails).
  const replayCode = await copy.evaluate(async (code) => (await fetch("/api/signoff/verify", { method: "POST", headers: { "Content-Type": "application/json", "x-signoff-token": sessionStorage.getItem("qt-signoff-token") }, body: JSON.stringify({ code }) })).status, code);
  check("a used code cannot be replayed from another browser", replayCode === 400);
  const custToken = await C.evaluate(() => sessionStorage.getItem("qt-signoff-token"));
  await clickText(C, "Acknowledge");
  await C.waitForSelector("input[name=name]");
  await C.type("input[name=name]", "Casey Customer");
  await C.click("form input[type=checkbox]");
  await clickText(C, "Submit");
  await C.waitForFunction(() => document.body.innerText.includes("Thank you"));
  check("customer acknowledgment recorded", true);
  const again = await C.evaluate(async (t) => (await (await fetch("/api/signoff/respond", { method: "POST", headers: { "Content-Type": "application/json", "x-signoff-token": t }, body: JSON.stringify({ decision: "confirm", typedName: "Casey Customer", agreed: true }) })).json()), custToken);
  check("an identical repeat is idempotent", again.repeated === true);
  const double = await C.evaluate(async (t) => (await fetch("/api/signoff/respond", { method: "POST", headers: { "Content-Type": "application/json", "x-signoff-token": t }, body: JSON.stringify({ decision: "decline" }) })).status, custToken);
  check("a conflicting second answer is refused", double === 409, `status ${double}`);
  const receipt = await waitFor(async () => outbox("customer_receipt", customerEmail));
  check("customer receipt sent (simulated)", !!receipt);

  await W.goto(`${APP}/evidence`, { waitUntil: "networkidle0" });
  await W.waitForFunction(() => document.body.innerText.includes("Simulated acknowledgment"));
  check("evidence list tag: Simulated acknowledgment (never shown as verification)", (await text(W)).includes("Simulated acknowledgment"));

  /* ---------------------------------------------------------------- supervisor invitation */
  const supEmail = `sky.${run}@supervisors.example`; // NOT on the allowlist: proves invite-only signup
  await W.goto(`${APP}/supervisors`, { waitUntil: "networkidle0" });
  await W.type("input[name=email]", workerEmail);
  await W.click("form input[type=checkbox]");
  await clickText(W, "Send invitation");
  await W.waitForFunction(() => document.body.innerText.includes("can't review your own work"));
  check("worker cannot invite their own address", true);
  await fill(W, "input[name=email]", supEmail);
  await clickText(W, "Send invitation");
  await W.waitForFunction(() => document.body.innerText.includes("Invitation sent"));
  const supInvite = await waitFor(async () => outbox("supervisor_invitation", supEmail));
  const supLink = linkIn(supInvite);
  check("supervisor invitation sent (simulated)", !!supLink);

  // Forwarded to someone else: a different confirmed account cannot accept.
  const strangerEmail = `stranger.${run}@test.qualitrail.dev`;
  const X = await persona("stranger");
  await signUp(X, strangerEmail, pw);
  await X.waitForFunction(() => location.pathname === "/onboarding");
  await X.waitForSelector("input[name=organization]");
  await fill(X, "form:has(input[name=organization]) input[name=name]", `Stranger ${run} (fictional)`);
  await clickText(X, "Create reviewer profile");
  await X.waitForFunction(() => location.pathname === "/supervisor");
  check("supervisor-only account lands on Reviews", (await X.url()).endsWith("/supervisor"));
  await X.goto(`${APP}/passport`, { waitUntil: "networkidle0" });
  check("supervisor-only account is kept off worker pages", (await X.url()).endsWith("/supervisor"));
  await X.goto(supLink, { waitUntil: "networkidle0" });
  await clickText(X, "Accept");
  await X.waitForFunction(() => document.body.innerText.includes("different email address"));
  check("forwarded invitation refused for a different account", true);

  // The invited supervisor: signs up through the link, sets up a profile, accepts.
  const SV = await persona("supervisor");
  await SV.goto(supLink, { waitUntil: "networkidle0" });
  await SV.waitForFunction(() => document.body.innerText.includes("Create an account"));
  await clickText(SV, "Create an account");
  await SV.waitForSelector("input[name=confirm]");
  await fill(SV, "input[name=email]", supEmail); await fill(SV, "input[name=password]", pw); await fill(SV, "input[name=confirm]", pw);
  await clickText(SV, "Create account");
  await SV.waitForFunction(() => document.body.innerText.includes("Check your email"));
  const supConfirm = await confirmLink(supEmail);
  check("invited supervisor may register while not on the allowlist path (invite-only)", !!supConfirm);
  await SV.goto(supConfirm, { waitUntil: "networkidle0" });
  await SV.waitForFunction(() => location.pathname === "/invite/supervisor");
  await SV.waitForFunction(() => document.body.innerText.includes("Set up profile"));
  await clickText(SV, "Set up profile");
  await SV.waitForSelector("input[name=organization]");
  await fill(SV, "form:has(input[name=organization]) input[name=name]", `Sky Supervisor ${run} (fictional)`);
  await fill(SV, "input[name=organization]", "Fictional Mechanical");
  await fill(SV, "input[name=title]", "Lead installer");
  await clickText(SV, "Create reviewer profile");
  await SV.waitForFunction(() => location.pathname === "/invite/supervisor");
  await SV.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Accept"));
  await clickText(SV, "Accept");
  await SV.waitForFunction(() => document.body.innerText.includes("You're connected"));
  check("invited supervisor accepts after signup and profile setup", true);
  await shot(SV, "04-supervisor-accepted");
  const supToken = supLink.split("#t=")[1];
  const answer = (p, accept) => p.evaluate(async (t, accept) => { const r = await fetch("/api/supervisor/invite/answer", { method: "POST", headers: { "Content-Type": "application/json", "x-signoff-token": t }, body: JSON.stringify({ accept }) }); return { status: r.status, body: await r.json() }; }, supToken, accept);
  const retry = await answer(SV, true);
  check("repeating the acceptance returns already-accepted", retry.status === 200 && retry.body.repeated === true && retry.body.status === "accepted", JSON.stringify(retry));
  const lateForward = await answer(X, true);
  check("after acceptance the link does nothing for another account", lateForward.status !== 200 && lateForward.body.error?.reason === "accepted", JSON.stringify(lateForward));
  const { data: relRow } = await admin.from("supervisor_relationships").select("token_hash, invited_email").eq("worker_id", wrow.id).eq("status", "accepted").single();
  check("no live invitation token or address kept after acceptance", relRow.token_hash === null && relRow.invited_email === null);
  // An invitation leads only to a reviewer profile.
  const svMe = await SV.evaluate(async () => (await fetch("/api/me")).json());
  const svWorker = await SV.evaluate(async () => (await fetch("/api/onboarding", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role: "worker", name: "Sky", trade: "HVAC" }) })).status);
  check("invited supervisor cannot create a technician profile", svMe.canOnboardWorker === false && svWorker === 403, `status ${svWorker}`);
  await SV.goto(`${APP}/onboarding`, { waitUntil: "networkidle0" });
  await SV.waitForFunction(() => document.body.innerText.includes("Technician profiles are open only"));
  check("onboarding shows no technician form to an invited supervisor", !(await SV.$("input[name=trade]")));

  /* ---------------------------------------------------------------- supervisor review */
  await openRecord(jobTitle);
  await W.waitForSelector("section[aria-label='Supervisor review'] select[name=relationship]");
  const sharing = await W.$eval("[data-testid=review-sharing]", (el) => el.innerText);
  check("before sending, the worker is told exactly what the supervisor will see", sharing.includes("What the supervisor will see") && sharing.includes("no uploaded document"));
  await clickText(W, "Ask for review");
  await W.waitForFunction(() => document.body.innerText.includes("Awaiting supervisor"));
  check("worker sends the job to the accepted supervisor", true);
  const { data: sentReq } = await admin.from("review_requests").select("has_original").eq("worker_id", wrow.id).single();
  check("no document is shared unless the worker chose to", sentReq.has_original === false);
  const notice = await waitFor(async () => outbox("review_notification", supEmail));
  const reviewUrl = notice?.text.match(/https?:\/\/\S+\/supervisor\/reviews\/[0-9a-f-]+/)?.[0];
  check("notification links to an authenticated page and states it approves nothing", !!reviewUrl && notice.text.includes("does not approve anything"));

  // The stranger (another supervisor) cannot open or answer it.
  const rid = reviewUrl.split("/").pop();
  const xs = await X.evaluate(async (rid) => [(await fetch(`/api/supervisor/reviews/${rid}`)).status, (await fetch(`/api/supervisor/reviews/${rid}/respond`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision: "decline" }) })).status], rid);
  check("another supervisor cannot read or answer the request", xs[0] === 404 && xs[1] === 404, xs.join(","));
  // Signed-out visit to the email link goes to sign-in; no decision.
  const anon = await persona("anon");
  await anon.goto(reviewUrl, { waitUntil: "networkidle0" });
  check("email link while signed out leads to sign-in", (await anon.url()).includes("/sign-in"));
  const statusAfterGet = (await admin.from("review_requests").select("status").eq("id", rid).single()).data.status;
  check("opening the review (GET) leaves it pending", statusAfterGet === "pending");

  await SV.goto(reviewUrl, { waitUntil: "networkidle0" });
  await SV.waitForFunction((t) => document.body.innerText.includes(t), {}, jobTitle);
  await SV.click("input[value=confirm_observed]");
  await SV.waitForSelector("input[name=task]");
  await SV.evaluate(() => { const t = [...document.querySelectorAll("input[name=task]")].find((i) => i.value === "Pulled vacuum to 500 microns"); t.click(); });
  await SV.evaluate(() => { const box = [...document.querySelectorAll("label")].find((l) => l.innerText.includes("I personally observed this technician")); box.querySelector("input").click(); });
  await clickText(SV, "Submit answer");
  await SV.waitForFunction(() => document.body.innerText.includes("Supervisor confirmed observing these tasks"));
  check("supervisor confirms exactly one observed task", true);
  await shot(SV, "05-supervisor-decided");
  const repeat = await SV.evaluate(async (rid) => (await (await fetch(`/api/supervisor/reviews/${rid}/respond`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision: "confirm_observed", observedTasks: ["Pulled vacuum to 500 microns"], agreed: true }) })).json()), rid);
  check("identical retry is idempotent", repeat.repeated === true);
  const conflict = await SV.evaluate(async (rid) => (await fetch(`/api/supervisor/reviews/${rid}/respond`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision: "decline" }) })).status, rid);
  check("conflicting retry is refused", conflict === 403, `status ${conflict}`);

  /* ---------------------------------------------------------------- supervisor review of a record with a PDF */
  // Upload needs Gemini (deliberately unavailable locally), so the two PDF records are written straight into the
  // LOCAL database and storage, labelled as fixtures. Everything after that goes through the real UI and API.
  const wAuth = (await admin.from("workers").select("auth_user_id").eq("id", wrow.id).single()).data.auth_user_id;
  async function pdfRecord(title) {
    const bytes = Buffer.from(`%PDF-1.4\n% LOCAL TEST FIXTURE: ${title}\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`);
    const path = `${wAuth}/fixture-${randomUUID()}.pdf`;
    const up = await admin.storage.from("evidence").upload(path, bytes, { contentType: "application/pdf" });
    if (up.error) throw new Error(`fixture upload failed: ${up.error.message}`);
    const { data, error } = await admin.from("evidence").insert({
      worker_id: wrow.id, type: "work_record", title, source_kind: "pdf_upload", storage_path: path, file_hash: createHash("sha256").update(bytes).digest("hex"),
      verification_status: "document_supplied", is_synthetic: true, structured_data: { activities: ["Replaced compressor contactor"], equipment: ["Rooftop unit"], summary: "LOCAL TEST FIXTURE" },
    }).select("id").single();
    if (error) throw new Error(`fixture insert failed: ${error.code}`);
    return data.id;
  }
  const inRecord = (title, fn, arg) => W.evaluate((title, fnSrc, arg) => {
    const d = [...document.querySelectorAll("details")].find((x) => x.querySelector("summary")?.innerText.includes(title));
    return new Function("d", "arg", fnSrc)(d, arg);
  }, title, fn, arg);
  const reqFor = async (eid) => (await admin.from("review_requests").select("id, has_original").eq("evidence_id", eid).single()).data;
  const svApi = (p, rid, path, body) => p.evaluate(async (rid, path, body) => {
    const r = await fetch(`/api/supervisor/reviews/${rid}${path}`, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
    return { status: r.status, body: await r.json().catch(() => null) };
  }, rid, path, body);

  const pdfA = `Rooftop unit A ${run} (LOCAL TEST FIXTURE)`;
  const eidA = await pdfRecord(pdfA);
  await openRecord(pdfA);
  await W.waitForFunction((t) => [...document.querySelectorAll("details")].some((d) => d.querySelector("summary")?.innerText.includes(t) && d.querySelector("[data-testid=review-sharing]")), {}, pdfA);
  const defaults = await inRecord(pdfA, 'const box = d.querySelector("input[name=shareOriginal]"); return { exists: !!box, checked: box?.checked, text: d.querySelector("[data-testid=review-sharing]").innerText };');
  check("PDF record: sharing the original is offered but OFF by default", defaults.exists && defaults.checked === false && defaults.text.includes("will not be shared"), JSON.stringify(defaults.checked));
  await inRecord(pdfA, '[...d.querySelectorAll("button")].find((b) => b.textContent.trim() === "Ask for review").click();');
  await W.waitForFunction((t) => [...document.querySelectorAll("details")].some((d) => d.querySelector("summary")?.innerText.includes(t) && d.innerText.includes("Awaiting supervisor")), {}, pdfA);
  const reqA = await waitFor(() => reqFor(eidA));
  check("sent with the default: the request does not include the PDF", reqA.has_original === false);
  const aGet = await svApi(SV, reqA.id, "");
  const aDoc = await svApi(SV, reqA.id, "/document");
  const aDecide = await svApi(SV, reqA.id, "/respond", { decision: "confirm_documents_reviewed", agreed: true });
  check("not shared: the supervisor sees the record but cannot open the PDF or claim a document review", aGet.status === 200 && aGet.body.review?.hasOriginal === false && aDoc.status === 404 && aDecide.status === 403, `${aGet.status},${aDoc.status},${aDecide.status}`);
  await SV.goto(`${APP}/supervisor/reviews/${reqA.id}`, { waitUntil: "networkidle0" });
  await SV.waitForFunction((t) => document.body.innerText.includes(t), {}, pdfA);
  const aPage = await text(SV);
  check("not shared: the review page offers no document button or document-review option", !aPage.includes("View supporting document") && !aPage.includes("I reviewed the supporting document") && aPage.includes("didn't share a supporting document"));

  const pdfB = `Rooftop unit B ${run} (LOCAL TEST FIXTURE)`;
  const eidB = await pdfRecord(pdfB);
  await openRecord(pdfB);
  await W.waitForFunction((t) => [...document.querySelectorAll("details")].some((d) => d.querySelector("summary")?.innerText.includes(t) && d.querySelector("[data-testid=review-sharing]")), {}, pdfB);
  await inRecord(pdfB, 'd.querySelector("input[name=shareOriginal]").click();');
  await sleep(300);
  const warned = await inRecord(pdfB, 'return d.querySelector("[data-testid=review-sharing]").innerText;');
  check("opting in shows the customer-information warning before sending", warned.includes("may contain customer names, addresses"));
  await shot(W, "05b-share-pdf-opt-in");
  await inRecord(pdfB, '[...d.querySelectorAll("button")].find((b) => b.textContent.trim() === "Ask for review").click();');
  await W.waitForFunction((t) => [...document.querySelectorAll("details")].some((d) => d.querySelector("summary")?.innerText.includes(t) && d.innerText.includes("Awaiting supervisor")), {}, pdfB);
  const reqB = await waitFor(() => reqFor(eidB));
  check("explicit opt-in: the request includes the PDF", reqB.has_original === true);
  const bDoc = await svApi(SV, reqB.id, "/document");
  const fetched = bDoc.status === 200 ? await fetch(bDoc.body.url) : null;
  const pdfBytes = fetched ? Buffer.from(await fetched.arrayBuffer()).toString("latin1") : "";
  check("the addressed supervisor can open the shared PDF (short-lived link)", bDoc.status === 200 && fetched?.status === 200 && pdfBytes.startsWith("%PDF") && pdfBytes.includes(pdfB), `${bDoc.status},${fetched?.status}`);
  await SV.goto(`${APP}/supervisor/reviews/${reqB.id}`, { waitUntil: "networkidle0" });
  await SV.waitForFunction((t) => document.body.innerText.includes(t), {}, pdfB);
  check("shared: the review page offers the document and the document-review option", (await text(SV)).includes("View supporting document") && (await text(SV)).includes("I reviewed the supporting document"));
  const xDoc = await svApi(X, reqB.id, "/document");
  const anonDoc = await anon.evaluate(async (rid) => (await fetch(`/api/supervisor/reviews/${rid}/document`)).status, reqB.id);
  check("another supervisor and a signed-out visitor cannot open the shared PDF", xDoc.status === 404 && anonDoc === 401, `${xDoc.status},${anonDoc}`);

  await W.goto(`${APP}/evidence`, { waitUntil: "networkidle0" });
  await W.waitForFunction(() => document.body.innerText.includes("Supervisor confirmed observing these tasks"));
  const ev = (await admin.from("evidence").select("id, verification_status, version").eq("worker_id", wrow.id).eq("title", jobTitle).single()).data;
  check("verification status untouched by acknowledgment and review", ev.verification_status === "self_reported");
  await shot(W, "06-worker-tags");

  /* ---------------------------------------------------------------- correction */
  await openRecord(jobTitle);
  await clickText(W, "Edit details");
  await W.waitForSelector(`#edit-${ev.id}-title`);
  await fill(W, `#edit-${ev.id}-title`, `${jobTitle} (corrected)`);
  await clickText(W, "Save changes");
  await W.waitForFunction(() => document.body.innerText.includes("Changed since review"));
  const tagsText = await text(W);
  check("after an edit: changed-since labels on both the acknowledgment and the review", tagsText.includes("Changed since simulated acknowledgment") && tagsText.includes("Changed since review"));
  await shot(W, "06b-changed-since");
  const after = (await admin.from("evidence").select("version, verification_status").eq("id", ev.id).single()).data;
  check("edit bumped the version and kept verification", after.version === ev.version + 1 && after.verification_status === "self_reported");
  const { data: ackRows } = await admin.from("signoff_requests").select("status, evidence_version").eq("evidence_id", ev.id);
  check("completed acknowledgment kept against its original version", ackRows.some((r) => r.status === "acknowledged" && r.evidence_version === ev.version));

  /* ---------------------------------------------------------------- revocation */
  const job2 = `Commissioning ${run}`;
  await W.goto(`${APP}/evidence`, { waitUntil: "networkidle0" });
  await fill(W, "form:has(textarea[name=activities]) input[name=title]", job2);
  await W.$eval("form:has(textarea[name=activities]) input[name=date]", (el) => { el.value = "2026-11-12"; });
  await W.type("form:has(textarea[name=activities]) textarea[name=activities]", "Verified airflow");
  await clickText(W, "Save job");
  await W.waitForFunction(() => document.body.innerText.includes("Job saved"));
  await openRecord(job2);
  await W.waitForSelector("section[aria-label='Supervisor review'] select[name=relationship]");
  await clickText(W, "Ask for review");
  await W.waitForFunction(() => document.body.innerText.includes("Awaiting supervisor"));
  const job2Id = (await admin.from("evidence").select("id").eq("worker_id", wrow.id).eq("title", job2).single()).data.id;
  // Other records on the page already say "Awaiting supervisor", so wait for this request in the database.
  const pendingRid = (await waitFor(async () => (await admin.from("review_requests").select("id").eq("evidence_id", job2Id).eq("status", "pending").maybeSingle()).data)).id;
  await SV.goto(`${APP}/supervisor`, { waitUntil: "networkidle0" });
  check("pending item appears in the supervisor dashboard", (await text(SV)).includes(job2));
  SV.on("dialog", (d) => d.accept());
  await clickText(SV, "End connection");
  await SV.waitForFunction(() => document.body.innerText.includes("No connections yet"));
  const pendAfter = (await admin.from("review_requests").select("status").eq("id", pendingRid).single()).data.status;
  check("supervisor ending the connection withdraws the pending review", pendAfter === "revoked");
  const blocked = await SV.evaluate(async (rid) => [(await fetch(`/api/supervisor/reviews/${rid}`)).status, (await fetch(`/api/supervisor/reviews/${rid}/respond`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision: "decline" }) })).status], pendingRid);
  const { count: lateAnswers } = await admin.from("review_responses").select("id", { count: "exact", head: true }).eq("request_id", pendingRid);
  check("after revocation the supervisor can neither read nor answer", blocked[0] === 404 && (blocked[1] === 404 || blocked[1] === 403) && lateAnswers === 0, blocked.join(","));
  const { count: keptReviews } = await admin.from("review_responses").select("id", { count: "exact", head: true }).eq("request_id", rid);
  check("completed review kept after revocation", keptReviews === 1);
  const revokedDoc = await svApi(SV, reqB.id, "/document");
  const revokedStatus = (await admin.from("review_requests").select("status").eq("id", reqB.id).single()).data.status;
  check("after revocation the supervisor can no longer open the shared PDF", revokedDoc.status === 404 && revokedStatus === "revoked", `${revokedDoc.status},${revokedStatus}`);

  /* ---------------------------------------------------------------- dual role */
  await W.goto(`${APP}/supervisor`, { waitUntil: "networkidle0" });
  check("worker without a reviewer profile is sent to onboarding for that role", (await W.url()).includes("/onboarding?role=supervisor"));
  await W.waitForSelector("input[name=organization]");
  await fill(W, "form:has(input[name=organization]) input[name=name]", `Wren Test ${run} (fictional)`);
  await clickText(W, "Create reviewer profile");
  await sleep(1500);
  await W.goto(`${APP}/passport`, { waitUntil: "networkidle0" });
  await W.waitForFunction(() => document.body.innerText.includes("Reviews"));
  const nav = await W.evaluate(() => [...document.querySelectorAll("aside nav a")].map((a) => a.textContent.trim()));
  check("dual-role navigation shows worker pages and Reviews", nav.includes("Passport") && nav.includes("Reviews") && nav.includes("Supervisors"), nav.join("|"));
  const dualDash = await W.evaluate(async () => (await (await fetch("/api/supervisor/dashboard")).json()));
  check("a reviewer profile alone grants no access to anyone's records", dualDash.reviews.length === 0 && dualDash.connections.length === 0);

  /* ---------------------------------------------------------------- packet */
  // Matching needs Supermemory, which is deliberately unavailable locally (it fails honestly). To test how the
  // packet RENDERS acknowledgments and reviews, write one completed run straight into the LOCAL database,
  // labelled as a fixture and with no similarity score.
  const { data: opp } = await admin.from("opportunities").select("id").eq("worker_id", wrow.id).single();
  const { data: reqs } = await admin.from("requirements").select("id").eq("opportunity_id", opp.id).order("position");
  const started = await admin.rpc("start_match_run", { p_worker_id: wrow.id, p_opportunity_id: opp.id });
  const fixture = "LOCAL TEST FIXTURE (not produced by matching).";
  const fin = await admin.rpc("finalize_match_run", {
    p_worker_id: wrow.id, p_run_id: started.data[0].id,
    p_results: reqs.map((r, i) => ({ requirement_id: r.id, assessment: i === 2 ? "needs_review" : "no_sufficient_evidence", explanation: fixture, uncertainties: [], missing_documentation: [] })),
    p_matches: [{ requirement_id: reqs[2].id, evidence_id: ev.id, role: "direct", contribution: fixture, relevance_explanation: fixture, memory_similarity: null }],
    p_memory_warning: fixture,
  });
  check("local fixture run completed", fin.data === "completed", JSON.stringify(fin.error ?? fin.data));
  await W.goto(`${APP}/reports`, { waitUntil: "networkidle0" });
  await W.waitForFunction(() => document.body.innerText.includes("Qualification packet"));
  await sleep(1500);
  const packet = await text(W);
  check("packet shows the supervisor review with its scope", packet.includes("Customer acknowledgments and supervisor reviews") && packet.includes("Pulled vacuum to 500 microns"));
  check("packet keeps the simulated acknowledgment visibly simulated and flags the change", packet.includes("Changed since simulated acknowledgment") && packet.includes("Simulated (no real email was sent)"));
  check("packet never shows the customer address or typed signature", !packet.includes(customerEmail) && !packet.includes("Casey Customer") && !packet.includes("casey"));
  await shot(W, "07-packet");

  /* ---------------------------------------------------------------- password recovery */
  const recoveryLink = (email, notThis) => waitFor(async () => {
    const s = await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)).json();
    for (const msg of s.messages ?? []) {
      const m = await (await fetch(`${MAILPIT}/api/v1/message/${msg.ID}`)).json();
      const l = (m.Text || m.HTML || "").match(/https?:\/\/[^\s"<>]+\/auth\/v1\/verify[^\s"<>]+/)?.[0]?.replace(/&amp;/g, "&");
      if (l && l.includes("type=recovery") && l !== notThis) return l;
    }
    return null;
  });
  const requestReset = async (p, email) => {
    await p.goto(`${APP}/forgot-password`, { waitUntil: "networkidle0" });
    await fill(p, "input[name=email]", email);
    await clickText(p, "Email me a reset link");
    await p.waitForFunction(() => document.body.innerText.includes("Check your email"));
  };
  const signInPage = await persona("sign-in-page");
  await signInPage.goto(`${APP}/sign-in`, { waitUntil: "networkidle0" });
  check("sign-in links to password reset", (await text(signInPage)).includes("Forgot password?"));
  const R = await persona("recovery");
  await requestReset(R, existingEmail);
  const link1 = await recoveryLink(existingEmail);
  check("a reset email arrives (local mail catcher)", !!link1);
  const R2 = await persona("other-browser");
  await R2.goto(link1, { waitUntil: "networkidle0" });
  check("a reset link opened in another browser is refused with an explanation", (await R2.url()).includes("/forgot-password?error=browser") && (await text(R2)).includes("browser that requested it"));
  await R.goto(link1, { waitUntil: "networkidle0" });
  check("a used reset link is reported as expired", (await R.url()).includes("/forgot-password?error=expired") && (await text(R)).includes("expired or was already used"));
  await requestReset(R, existingEmail);
  const link2 = await recoveryLink(existingEmail, link1);
  await R.goto(link2, { waitUntil: "networkidle0" });
  await R.waitForSelector("input[name=confirm]");
  check("a fresh reset link opens the new-password form", (await R.url()).endsWith("/reset-password"));
  // An ordinary signed-in session can't change the password without a reset link.
  await E.goto(`${APP}/reset-password`, { waitUntil: "networkidle0" });
  await E.waitForFunction(() => document.body.innerText.includes("This reset link has expired"));
  const noMarker = await E.evaluate(async () => (await fetch("/api/auth/reset-password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "Another-password-123" }) })).status);
  check("a normal session without a reset link cannot set a password", noMarker === 403, `status ${noMarker}`);
  const newPw = `New-${randomUUID()}`;
  await fill(R, "input[name=password]", newPw);
  await fill(R, "input[name=confirm]", newPw);
  await clickText(R, "Set new password");
  await R.waitForFunction(() => document.body.innerText.includes("Password changed"));
  check("password changed through the reset form", true);
  const reuse = await R.evaluate(async () => (await fetch("/api/auth/reset-password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "Yet-another-password-1" }) })).status);
  check("the reset permission is used up after one change", reuse === 403, `status ${reuse}`);
  const otherSession = await E.evaluate(async () => (await fetch("/api/me")).status);
  check("other sessions are signed out after a reset", otherSession === 401, `status ${otherSession}`);
  const S2 = await persona("signin-after-reset");
  await S2.goto(`${APP}/sign-in`, { waitUntil: "networkidle0" });
  await fill(S2, "input[name=email]", existingEmail); await fill(S2, "input[name=password]", pw);
  await clickText(S2, "Sign in");
  await S2.waitForFunction(() => document.body.innerText.includes("Sign-in failed"));
  await fill(S2, "input[name=password]", newPw);
  await clickText(S2, "Sign in");
  await S2.waitForFunction(() => location.pathname === "/passport");
  check("old password refused, new password signs in", (await S2.url()).endsWith("/passport"));
  for (const [q, want] of [["code=bogus&next=%2F%2Fevil.test", "/sign-in"], ["error=access_denied&error_code=otp_expired&next=%2Freset-password", "/forgot-password?error=expired"], ["next=https%3A%2F%2Fevil.test", "/sign-in"]]) {
    const r = await fetch(`${APP}/auth/confirm?${q}`, { redirect: "manual" });
    const loc = new URL(r.headers.get("location"), APP);
    check(`email-link callback stays on this site (${q.split("&")[0]})`, loc.origin === new URL(APP).origin && (loc.pathname + loc.search).startsWith(want), loc.href);
  }

  /* ---------------------------------------------------------------- persistent rate limit */
  const statuses = await anon.evaluate(async () => {
    const out = [];
    for (let i = 0; i < 12; i++) {
      const r = await fetch("/api/auth/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: `flood${i}@not-allowed.example`, password: "x".repeat(12) }) });
      out.push(r.status);
    }
    return out;
  });
  check("sign-up is rate limited (persisted in the database)", statuses.includes(429), statuses.join(","));

  /* ---------------------------------------------------------------- logs */
  if (SERVER_LOG) {
    const log = readFileSync(SERVER_LOG, "utf8");
    check("server log holds no customer address, code or token", !log.includes(customerEmail) && !log.includes(code) && !log.includes(custLink.split("#t=")[1]));
  }
} catch (e) {
  check("journey aborted", false, e.message);
  for (const pg of await Promise.all((await browser.browserContexts()).map((c) => c.pages()))) for (const [i, p] of pg.entries()) await p.screenshot({ path: `${SHOTS}/fail-${Date.now()}-${i}.png`, fullPage: true }).catch(() => {});
} finally {
  check("no uncaught page errors", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}
