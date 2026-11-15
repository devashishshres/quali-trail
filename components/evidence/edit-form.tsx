"use client";
import { useState } from "react";
import type { ConfirmedEvidenceFields, Evidence } from "@/lib/types";
import { toApiError } from "@/lib/client/errors";
import { signoffApi } from "@/lib/client/signoff-api";
import { Notice } from "../ui/states";

const lines = (s: FormDataEntryValue | null) => String(s ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
const orNull = (s: FormDataEntryValue | null) => String(s ?? "").trim() || null;

/** Edit a saved work record or checklist. Type and verification status are not editable here. */
export function EditForm({ evidence: e, onSaved, onCancel }: { evidence: Evidence; onSaved: (e: Evidence) => void; onCancel: () => void }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const sd = e.structuredData;
  const err = (n: string) => fieldErrors[`fields.${n}`] ?? fieldErrors[`fields.structuredData.${n}`];

  async function onSubmit(ev: React.FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    const f = new FormData(ev.currentTarget);
    const fields: ConfirmedEvidenceFields = {
      type: e.type,
      title: String(f.get("title") ?? "").trim(),
      date: orNull(f.get("date")),
      issuer: orNull(f.get("issuer")),
      structuredData: { ...sd, skills: lines(f.get("skills")), activities: lines(f.get("activities")), equipment: lines(f.get("equipment")), summary: orNull(f.get("summary")) },
    };
    setSaving(true);
    setError(null);
    setFieldErrors({});
    try {
      onSaved((await signoffApi.editEvidence(e.id, fields)).evidence);
    } catch (x) {
      const a = toApiError(x);
      setError(a.message);
      setFieldErrors(a.fieldErrors ?? {});
    } finally {
      setSaving(false);
    }
  }
  const input = (name: string) => ({ name, id: `edit-${e.id}-${name}`, className: "field", "aria-invalid": err(name) ? true : undefined });
  const msg = (n: string) => err(n) && <span className="mt-1 block text-xs text-danger">{err(n)!.join(" ")}</span>;

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <Notice tone="warning" title="Editing changes what customers and reports see">
        Saving bumps the record&apos;s version, makes saved reports out of date, and cancels any open customer request for the old version. It does not change the verification label.
      </Notice>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block"><span className="mb-1 block text-sm font-semibold">Title</span><input {...input("title")} defaultValue={e.title} required maxLength={300} />{msg("title")}</label>
        <label className="block"><span className="mb-1 block text-sm font-semibold">Date of work</span><input type="date" {...input("date")} defaultValue={e.date ?? ""} />{msg("date")}</label>
        <label className="block sm:col-span-2"><span className="mb-1 block text-sm font-semibold">Issuer or employer</span><input {...input("issuer")} defaultValue={e.issuer ?? ""} maxLength={300} />{msg("issuer")}</label>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <label className="block"><span className="mb-1 block text-sm font-semibold">Skills (one per line)</span><textarea {...input("skills")} rows={4} defaultValue={sd.skills.join("\n")} />{msg("skills")}</label>
        <label className="block"><span className="mb-1 block text-sm font-semibold">Work performed</span><textarea {...input("activities")} rows={4} defaultValue={sd.activities.join("\n")} />{msg("activities")}</label>
        <label className="block"><span className="mb-1 block text-sm font-semibold">Equipment</span><textarea {...input("equipment")} rows={4} defaultValue={sd.equipment.join("\n")} />{msg("equipment")}</label>
      </div>
      <label className="block"><span className="mb-1 block text-sm font-semibold">Summary</span><textarea {...input("summary")} rows={3} defaultValue={sd.summary ?? ""} maxLength={2000} />{msg("summary")}</label>
      {error && <Notice tone="danger" title="Couldn't save your changes">{error}</Notice>}
      <div className="flex gap-3">
        <button className="btn btn-primary" disabled={saving}>{saving ? "Saving…" : "Save changes"}</button>
        <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={saving}>Cancel</button>
      </div>
    </form>
  );
}
