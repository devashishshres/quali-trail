/**
 * Seeds the fictional demo technician (Alex Morgan).
 *
 *   npx tsx --env-file=.env.local supabase/seed/seed-demo.ts
 *
 * Safe to re-run: every write is an upsert on a fixed id.
 * Uses the SECRET (service-role) key, so it must only ever run on a developer
 * machine or CI — never import this file from app code.
 *
 * Supermemory indexing is NOT done here. Seeded rows start as
 * index_status = 'pending'; run the indexing step afterwards so the
 * demo never shows a record as indexed before Supermemory confirms it.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { DEMO_USER_EMAIL, REQUIREMENT_SOURCE } from "./demo-data";
import { planDemoWorker } from "./synthetic-worker";

// Run from the repo root (works whether the package is ESM or CJS).
const FILES_DIR = join(process.cwd(), "supabase", "seed", "files");
const BUCKET = "evidence";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

async function main() {
  // Optional: DEMO_WORKER_SLUG + DEMO_WORKER_NAME (+ DEMO_USER_EMAIL, DEMO_WORKER_SUMMARY) seed a NEW fictional
  // worker with its own ids. Without a slug this is the original Alex Morgan seed, unchanged.
  const plan = planDemoWorker({ slug: process.env.DEMO_WORKER_SLUG, name: process.env.DEMO_WORKER_NAME, summary: process.env.DEMO_WORKER_SUMMARY });
  if (!plan.isOriginal && !process.env.DEMO_USER_EMAIL) throw new Error("DEMO_USER_EMAIL is required with DEMO_WORKER_SLUG (it must differ from the existing demo account).");
  if (!plan.isOriginal && process.env.DEMO_USER_EMAIL === DEMO_USER_EMAIL) throw new Error("DEMO_USER_EMAIL must differ from the existing demo account.");
  const supabase = createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SECRET_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  // 1. Demo auth user
  const password = requireEnv("DEMO_USER_PASSWORD");
  let authUserId: string;
  // DEMO_USER_EMAIL may be set in .env.local when the account already exists under another address.
  const demoEmail = process.env.DEMO_USER_EMAIL ?? DEMO_USER_EMAIL;
  const created = await supabase.auth.admin.createUser({
    email: demoEmail,
    password,
    email_confirm: true,
  });
  if (created.data.user) {
    authUserId = created.data.user.id;
  } else {
    const { data, error } = await supabase.auth.admin.listUsers({ perPage: 1000 });
    if (error) throw error;
    const existing = data.users.find((u) => u.email === demoEmail);
    if (!existing) throw created.error ?? new Error("Could not create or find demo user");
    authUserId = existing.id;
  }

  // 2. Worker
  const { error: workerError } = await supabase.from("workers").upsert({
    id: plan.worker.id,
    auth_user_id: authUserId,
    name: plan.worker.name,
    trade: plan.worker.trade,
    // Only synthetic rehearsal workers carry a summary (the column comes from the summary migration).
    ...(plan.worker.summary ? { summary: plan.worker.summary } : {}),
    is_synthetic: true,
  });
  if (workerError) throw workerError;

  // 3. Evidence (+ original files when present)
  for (const item of plan.evidence) {
    let storagePath: string | null = null;
    let fileHash = sha256(`seed:${item.id}`);

    const filePath = item.fileName ? join(FILES_DIR, item.fileName) : null;
    if (filePath && existsSync(filePath)) {
      const bytes = readFileSync(filePath);
      fileHash = sha256(bytes);
      storagePath = `${authUserId}/${item.id}.pdf`;
      const { error } = await supabase.storage
        .from(BUCKET)
        .upload(storagePath, bytes, { contentType: "application/pdf", upsert: true });
      if (error) throw error;
    } else if (filePath) {
      console.warn(`! ${item.fileName} not found — seeding "${item.title}" without an original file`);
    }

    const { error } = await supabase.from("evidence").upsert({
      id: item.id,
      worker_id: plan.worker.id,
      type: item.type,
      title: item.title,
      source_date: item.date,
      issuer: item.issuer,
      structured_data: item.structuredData,
      source_kind: item.sourceKind,
      storage_path: storagePath,
      mime_type: storagePath ? "application/pdf" : null,
      file_hash: fileHash,
      verification_status: item.verificationStatus,
      is_synthetic: true,
    });
    if (error) throw error;
  }

  // 4. Opportunity + requirements
  const { error: oppError } = await supabase.from("opportunities").upsert({
    id: plan.opportunity.id,
    worker_id: plan.worker.id,
    title: plan.opportunity.title,
    employer: plan.opportunity.employer,
    description: plan.opportunity.description,
    source_url: plan.opportunity.sourceUrl,
    is_synthetic: true,
  });
  if (oppError) throw oppError;

  const { error: reqError } = await supabase.from("requirements").upsert(
    plan.requirements.map((r) => ({
      id: r.id,
      opportunity_id: plan.opportunity.id,
      position: r.position,
      original_text: r.originalText,
      criteria_json: r.criteria,
      mandatory: r.mandatory,
      source: REQUIREMENT_SOURCE,
    })),
  );
  if (reqError) throw reqError;

  console.log(
    `Seeded ${plan.worker.name}: ${plan.evidence.length} evidence records, 1 opportunity, ${plan.requirements.length} requirements.`,
  );
}

main().catch((err) => {
  console.error("Seed failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
