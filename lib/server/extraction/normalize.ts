/**
 * Clean and validate Gemini's output. PURE. Model output is untrusted: it is
 * coerced into the contract, and anything invalid is dropped (set to null),
 * never "repaired" with a guess.
 */
import { ExtractedEvidence, EvidenceType } from "@/lib/types";

const trimOrNull = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, " ").trim();
  return s.length === 0 ? null : s.slice(0, max);
};

const list = (v: unknown): string[] =>
  (Array.isArray(v) ? v : [])
    .map((x) => trimOrNull(x, 300))
    .filter((x): x is string => x !== null)
    .slice(0, 30);

const isoDate = (v: unknown): string | null => {
  const s = trimOrNull(v, 10);
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : s;
};

const FIELDS = ["type", "title", "date", "issuer", "expirationDate", "credentialNumber"] as const;

/** Returns a valid ExtractedEvidence, or null if the output is unusable. */
export function normalizeExtraction(raw: unknown, sourceText?: string): ExtractedEvidence | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const sd = (typeof r.structuredData === "object" && r.structuredData !== null ? r.structuredData : {}) as Record<string, unknown>;

  const type = EvidenceType.safeParse(r.type);
  const uncertain = new Set<string>(
    (Array.isArray(r.uncertainFields) ? r.uncertainFields : []).filter((f): f is string => typeof f === "string" && (FIELDS as readonly string[]).includes(f)),
  );

  let date = isoDate(r.date);
  let expirationDate = isoDate(sd.expirationDate);

  // For typed text we can check grounding: a year the source never mentions is a guess.
  if (sourceText) {
    for (const [name, value] of [["date", date], ["expirationDate", expirationDate]] as const) {
      if (value && !sourceText.includes(value.slice(0, 4))) {
        uncertain.add(name);
        if (name === "date") date = null;
        else expirationDate = null;
      }
    }
  }

  const candidate = {
    type: type.success ? type.data : null,
    title: trimOrNull(r.title, 300),
    date,
    issuer: trimOrNull(r.issuer, 300),
    structuredData: {
      skills: list(sd.skills),
      activities: list(sd.activities),
      equipment: list(sd.equipment),
      expirationDate,
      credentialNumber: trimOrNull(sd.credentialNumber, 100),
      summary: trimOrNull(sd.summary, 2000),
    },
    uncertainFields: [...uncertain],
  };
  if (!type.success) uncertain.add("type");
  if (candidate.title === null) uncertain.add("title");
  candidate.uncertainFields = [...uncertain];

  const parsed = ExtractedEvidence.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}
