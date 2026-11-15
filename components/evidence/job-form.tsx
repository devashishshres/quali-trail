"use client";
import { useState } from "react";
import type { ConfirmedEvidenceFields, Evidence } from "@/lib/types";
import { api } from "@/lib/client/api";
import { ApiRequestError, toApiError } from "@/lib/client/errors";
import { call, post } from "@/lib/client/signoff-api";
import { Notice } from "../ui/states";

const lines = (s: FormDataEntryValue | null) => String(s ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
const orNull = (s: FormDataEntryValue | null) => String(s ?? "").trim() || null;

/**
 * Log a completed job. Without a document it is saved as a self-reported work record. With a supporting PDF it
 * goes through the same upload -> stored original -> confirm path as any other document (labelled "document
 * supplied"), using the details typed here. Either way the result is an ordinary record: indexed and matched.
 */
export function JobForm({ onSaved }: { onSaved: (e: Evidence) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const err = (k: string) => (fieldErrors[k] ?? fieldErrors[`fields.${k}`] ?? fieldErrors[`fields.structuredData.${k}`]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const file = f.get("file");
    const job = {
      type: (f.get("type") === "checklist" ? "checklist" : "work_record") as "work_record" | "checklist",
      title: String(f.get("title") ?? "").trim(),
      date: String(f.get("date") ?? ""),
      issuer: orNull(f.get("issuer")),
      activities: lines(f.get("activities")),
      equipment: lines(f.get("equipment")),
      skills: lines(f.get("skills")),
      summary: orNull(f.get("summary")),
    };
    setError(null);
    setFieldErrors({});
    try {
      let saved: Evidence;
      if (file instanceof File && file.size > 0) {
        setBusy("Uploading the document…");
        const { draft } = await api.extractFile(file);
        if (draft.duplicateOfEvidenceId) throw new ApiRequestError("duplicate_evidence", 409, "This document is already saved as another record.");
        setBusy("Saving…");
        const fields: ConfirmedEvidenceFields = {
          type: job.type, title: job.title, date: job.date, issuer: job.issuer,
          structuredData: { skills: job.skills, activities: job.activities, equipment: job.equipment, expirationDate: null, credentialNumber: null, summary: job.summary },
        };
        saved = (await api.confirmEvidence({ draftId: draft.draftId, fields })).evidence;
      } else {
        setBusy("Saving…");
        saved = (await call<{ evidence: Evidence }>("/api/jobs", post(job))).evidence;
      }
      form.reset();
      onSaved(saved);
    } catch (x) {
      const a = toApiError(x);
      setError(a.message);
      setFieldErrors(a.fieldErrors ?? {});
    } finally {
      setBusy(null);
    }
  }
  const msg = (k: string) => err(k) && <span className="mt-1 block text-xs text-danger">{err(k)!.join(" ")}</span>;

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div>
        <h3 className="font-display text-2xl font-semibold">Log a completed job</h3>
        <p className="text-sm text-slate">Record what you did. Afterwards you can ask the customer to acknowledge it, or a supervisor to review it.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block"><span className="mb-1 block text-sm font-semibold">Job title</span><input name="title" className="field" required maxLength={300} placeholder="e.g. Heat-pump install, 3-ton ducted" />{msg("title")}</label>
        <label className="block"><span className="mb-1 block text-sm font-semibold">Date completed</span><input name="date" type="date" className="field" required />{msg("date")}</label>
        <label className="block"><span className="mb-1 block text-sm font-semibold">Employer or company (optional)</span><input name="issuer" className="field" maxLength={300} />{msg("issuer")}</label>
        <label className="block"><span className="mb-1 block text-sm font-semibold">Record type</span>
          <select name="type" className="field" defaultValue="work_record"><option value="work_record">Work record</option><option value="checklist">Checklist</option></select>
        </label>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <label className="block"><span className="mb-1 block text-sm font-semibold">Tasks you did (one per line)</span><textarea name="activities" className="field" rows={4} required />{msg("activities")}</label>
        <label className="block"><span className="mb-1 block text-sm font-semibold">Equipment (one per line)</span><textarea name="equipment" className="field" rows={4} />{msg("equipment")}</label>
        <label className="block"><span className="mb-1 block text-sm font-semibold">Skills used (optional)</span><textarea name="skills" className="field" rows={4} />{msg("skills")}</label>
      </div>
      <label className="block"><span className="mb-1 block text-sm font-semibold">Notes (optional)</span><textarea name="summary" className="field" rows={2} maxLength={2000} /></label>
      <label className="block"><span className="mb-1 block text-sm font-semibold">Supporting document (optional PDF, up to 10 MB)</span><input name="file" type="file" accept="application/pdf" className="field" /><span className="mt-1 block text-xs text-slate">For example a signed work order or commissioning sheet. The original is kept privately with the record.</span></label>
      <p className="text-xs text-slate">Saved as <strong>Self-reported</strong> without a document, or <strong>Document supplied</strong> with one. Neither means anyone has independently confirmed the job.</p>
      {error && <Notice tone="danger" title="Couldn't save this job">{error}</Notice>}
      <button className="btn btn-primary" disabled={busy !== null}>{busy ?? "Save job"}</button>
    </form>
  );
}
