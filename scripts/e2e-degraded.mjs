// Existing pages with every new feature OFF and the release's tables ABSENT (code deployed before migrations).
// ISOLATED LOCAL stack only. Prepare it with:
//   npx supabase db reset --local --version 20261115120000     # schema as on main, without the three new migrations
//   start the app with SIGNOFF_ENABLED=false SUPERVISOR_REVIEW_ENABLED=false EMAIL_MODE=off
// Then: node scripts/e2e-degraded.mjs. Afterwards restore the full schema with `npx supabase db reset --local`.
import { createHash, randomUUID } from "node:crypto";
import puppeteer from "puppeteer-core";
import { createClient } from "@supabase/supabase-js";

const APP = process.env.E2E_APP_URL ?? "http://localhost:3100";
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const host = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://x.invalid").hostname;
if (host !== "127.0.0.1" && host !== "localhost") throw new Error("e2e-degraded only runs against a LOCAL Supabase stack");
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const results = [];
const check = (name, ok, detail = "") => { results.push({ ok: !!ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };

const absent = await admin.from("signoff_requests").select("id").limit(0);
check("precondition: the release's tables are absent", absent.error?.code === "PGRST205", absent.error?.code ?? "present");

const run = randomUUID().slice(0, 6);
const email = `degraded.${run}@test.qualitrail.dev`, pw = `Pw-${randomUUID()}`;
const u = await admin.auth.admin.createUser({ email, password: pw, email_confirm: true });
const { data: w } = await admin.from("workers").insert({ auth_user_id: u.data.user.id, name: `Degraded Check ${run} (fictional)`, trade: "HVAC", is_synthetic: true }).select("id").single();
const seeded = await admin.from("evidence").insert({ worker_id: w.id, type: "work_record", title: `Fictional job ${run}`, source_kind: "manual_text", file_hash: createHash("sha256").update(`degraded-${run}`).digest("hex"), verification_status: "self_reported", index_status: "failed", is_synthetic: true, structured_data: { activities: ["Brazed line set"] } });
if (seeded.error) throw new Error(`seed failed: ${seeded.error.code}`);

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
const errors = [];
try {
  const p = await (await browser.createBrowserContext()).newPage();
  p.setDefaultTimeout(20000);
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(`${APP}/sign-in`, { waitUntil: "networkidle0" });
  await p.type("input[name=email]", email);
  await p.type("input[name=password]", pw);
  await p.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Sign in").click());
  await p.waitForFunction(() => location.pathname === "/passport");
  check("existing worker signs in to Passport", true);

  for (const path of ["/passport", "/evidence", "/opportunities", "/reports"]) {
    await p.goto(`${APP}${path}`, { waitUntil: "networkidle0" });
    await new Promise((r) => setTimeout(r, 1200));
    const t = await p.evaluate(() => document.body.innerText);
    check(`${path} loads without an error notice`, p.url().endsWith(path) && !/Couldn't load|Something went wrong|Application error/i.test(t), p.url());
  }
  await p.goto(`${APP}/evidence`, { waitUntil: "networkidle0" });
  await p.waitForFunction((t) => document.body.innerText.includes(t), {}, `Fictional job ${run}`).catch(() => null);
  check("saved records still list the existing record", (await p.evaluate(() => document.body.innerText)).includes(`Fictional job ${run}`));
  await p.evaluate(() => { const s = document.querySelector("summary"); if (s) s.closest("details").open = true; });
  await new Promise((r) => setTimeout(r, 1200));
  const opened = await p.evaluate(() => document.body.innerText);
  check("no sign-off or review controls while the features are off", !opened.includes("Send request") && !opened.includes("Ask for review"));
  const nav = await p.evaluate(() => [...document.querySelectorAll("aside nav a")].map((a) => a.textContent.trim()));
  check("navigation shows worker pages only", nav.includes("Passport") && !nav.includes("Supervisors") && !nav.includes("Reviews"), nav.join("|"));

  const api = await p.evaluate(async () => Object.fromEntries(await Promise.all(["/api/me", "/api/attestations", "/api/evidence", "/api/signoff/requests", "/api/reviews", "/api/supervisors"].map(async (u) => [u, (await fetch(u)).status]))));
  check("read APIs answer normally", Object.values(api).every((s) => s === 200), JSON.stringify(api));
  const writes = await p.evaluate(async () => {
    const post = (u, b) => fetch(u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.status);
    return { signoff: await post("/api/signoff/requests", {}), review: await post("/api/reviews", {}), invite: await post("/api/supervisors", {}) };
  });
  check("new activity is switched off (404), nothing half-works", writes.signoff === 404 && writes.review === 404 && writes.invite === 404, JSON.stringify(writes));

  const anon = await (await browser.createBrowserContext()).newPage();
  for (const path of ["/sign-up", "/forgot-password", "/reset-password"]) {
    await anon.goto(`${APP}${path}`, { waitUntil: "networkidle0" });
    check(`${path} renders signed out`, anon.url().endsWith(path));
  }
  const signup = await anon.evaluate(async () => { const r = await fetch("/api/auth/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "nobody@not-allowed.example", password: "x".repeat(12) }) }); const j = await r.json().catch(() => ({})); return { status: r.status, code: j.error?.code, message: j.error?.message ?? "" }; });
  check("sign-up without the migrations is refused as 'setup incomplete' (503), not 'too many attempts'", signup.status === 503 && signup.code === "unavailable" && !/too many/i.test(signup.message), JSON.stringify(signup));
} catch (e) {
  check("aborted", false, e.message);
} finally {
  check("no uncaught page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  await browser.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
