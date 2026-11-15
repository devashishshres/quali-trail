"use client";
import { useState } from "react";
import { EvidenceType, type ConfirmedEvidenceFields, type Evidence, type EvidenceDraft } from "@/lib/types";
import { api, toApiError } from "@/lib/client/api";
import { TYPE_LABEL } from "@/lib/client/labels";
import { Notice } from "../ui/states";
import { Icon } from "../ui/icons";

type Uncertain = NonNullable<EvidenceDraft["extraction"]>["uncertainFields"][number];

const lines = (s: FormDataEntryValue | null) =>
  String(s ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
const orNull = (s: FormDataEntryValue | null) => String(s ?? "").trim() || null;

function Field({
  label,
  hint,
  uncertain,
  messages,
  children,
}: {
  label: string;
  hint?: string;
  uncertain: boolean;
  messages?: string[];
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 flex items-baseline justify-between gap-2 text-sm font-semibold">
        {label}
        {uncertain && <span className="text-xs font-medium text-orange-ink">Check this. Gemini wasn&apos;t sure</span>}
      </span>
      {children}
      {hint && !messages && <span className="mt-1 block text-xs text-slate">{hint}</span>}
      {messages && <span className="mt-1 block text-xs text-danger">{messages.join(" ")}</span>}
    </label>
  );
}

/**
 * Step 2 of capture: the worker reviews what Gemini proposed. Empty fields
 * stay empty — nothing is filled in on the model's behalf.
 */
export function ReviewForm({
  draft,
  onSaved,
  onDiscard,
}: {
  draft: EvidenceDraft;
  onSaved: (e: Evidence) => void;
  onDiscard: () => void;
}) {
  const x = draft.extraction;
  const sd = x?.structuredData;
  const uncertain = new Set<Uncertain>(x?.uncertainFields ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const fields: ConfirmedEvidenceFields = {
      type: EvidenceType.parse(f.get("type")),
      title: String(f.get("title") ?? "").trim(),
      date: orNull(f.get("date")),
      issuer: orNull(f.get("issuer")),
      structuredData: {
        skills: lines(f.get("skills")),
        activities: lines(f.get("activities")),
        equipment: lines(f.get("equipment")),
        expirationDate: orNull(f.get("expirationDate")),
        credentialNumber: orNull(f.get("credentialNumber")),
        summary: orNull(f.get("summary")),
      },
    };
    setSaving(true);
    setError(null);
    setFieldErrors({});
    try {
      const { evidence } = await api.confirmEvidence({ draftId: draft.draftId, fields });
      onSaved(evidence);
    } catch (err) {
      const apiErr = toApiError(err);
      setError(apiErr.message);
      setFieldErrors(apiErr.fieldErrors ?? {});
    } finally {
      setSaving(false);
    }
  }

  const err = (path: string) => fieldErrors[`fields.${path}`] ?? fieldErrors[`fields.structuredData.${path}`];

  const meta = (name: string) => ({ uncertain: uncertain.has(name as Uncertain), messages: err(name) });
  const fieldProps = (name: string) => ({
    name,
    id: name,
    className: "field",
    "data-uncertain": uncertain.has(name as Uncertain) || undefined,
    "aria-invalid": err(name) ? true : undefined,
  });

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-display text-2xl font-semibold">Review the details</h3>
          <p className="text-sm text-slate">
            {draft.fileName ? `From ${draft.fileName}. ` : "From your description. "}
            Correct anything that&apos;s wrong, then save. Blank fields weren&apos;t found in the source.
          </p>
        </div>
      </div>

      {draft.extractionError && (
        <Notice tone="warning" title="Gemini couldn't read this">
          {draft.extractionError} Fill in the details yourself. Your document is kept with the record.
        </Notice>
      )}
      {draft.duplicateOfEvidenceId && (
        <Notice
          tone="warning"
          title="You already saved this document"
          action={
            <a href={`#evidence-${draft.duplicateOfEvidenceId}`} className="btn btn-secondary">
              Show saved record
            </a>
          }
        >
          Saving it again would be rejected as a duplicate.
        </Notice>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field {...meta("title")} label="Title">
          <input {...fieldProps("title")} defaultValue={x?.title ?? ""} required maxLength={300} />
        </Field>
        <Field {...meta("type")} label="Record type">
          <select {...fieldProps("type")} defaultValue={x?.type ?? ""} required>
            <option value="" disabled>
              Choose a type
            </option>
            {EvidenceType.options.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </Field>
        <Field {...meta("date")} label="Date of work or issue">
          <input type="date" {...fieldProps("date")} defaultValue={x?.date ?? ""} />
        </Field>
        <Field {...meta("issuer")} label="Issuer or employer">
          <input {...fieldProps("issuer")} defaultValue={x?.issuer ?? ""} maxLength={300} />
        </Field>
        <Field {...meta("credentialNumber")} label="Credential number" hint="As printed on the document, if any.">
          <input {...fieldProps("credentialNumber")} defaultValue={sd?.credentialNumber ?? ""} maxLength={100} />
        </Field>
        <Field {...meta("expirationDate")} label="Expiration date" hint="Only if the document states one. Some credentials, like EPA 608, never expire.">
          <input type="date" {...fieldProps("expirationDate")} defaultValue={sd?.expirationDate ?? ""} />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field {...meta("skills")} label="Skills" hint="One per line.">
          <textarea {...fieldProps("skills")} rows={4} defaultValue={sd?.skills.join("\n")} />
        </Field>
        <Field {...meta("activities")} label="Work performed" hint="One per line.">
          <textarea {...fieldProps("activities")} rows={4} defaultValue={sd?.activities.join("\n")} />
        </Field>
        <Field {...meta("equipment")} label="Equipment and systems" hint="One per line.">
          <textarea {...fieldProps("equipment")} rows={4} defaultValue={sd?.equipment.join("\n")} />
        </Field>
      </div>

      <Field {...meta("summary")} label="Summary">
        <textarea {...fieldProps("summary")} rows={3} defaultValue={sd?.summary ?? ""} maxLength={2000} />
      </Field>

      <p className="flex gap-2 rounded-md bg-paper px-3 py-2 text-sm text-slate">
        <Icon name="seal" className="mt-0.5 size-4 shrink-0" />
        This will be saved as {draft.sourceKind === "pdf_upload" ? "Document supplied" : "Self-reported"}. Only an authorized human
        reviewer can mark a record independently confirmed.
      </p>

      {error && <Notice tone="danger" title="Couldn't save this record">{error}</Notice>}

      <div className="flex flex-wrap gap-3">
        <button className="btn btn-primary" disabled={saving}>
          {saving ? "Saving…" : "Save evidence"}
        </button>
        <button type="button" className="btn btn-secondary" onClick={onDiscard} disabled={saving}>
          Discard
        </button>
      </div>
    </form>
  );
}
