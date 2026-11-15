/**
 * Work-task breakdown for requirements the strict evaluator cannot assess. PURE and deterministic: no model.
 *
 * It splits a compound task line ("brazing, pressure testing, evacuation and charging") into parts using an
 * EXPLICIT synonym list, keeps the line's AND/OR meaning, and checks each part against the wording of the
 * technician's own related records:
 *   - only the record's title, skills and work performed can show a task as documented;
 *   - "did not …", "by another crew", "assisted with …" are kept as what they say;
 *   - a mention only in the free-text summary or equipment list is reported as such, never as documented.
 *
 * The result is shown as related evidence. It never changes the checked assessment or any count. The employer's
 * full wording is always shown unchanged next to it.
 */
import type { Evidence } from "@/lib/types";
import type { TaskBreakdown, TaskPart, TaskPartStatus } from "@/lib/types/explanations";
import { normalizeLine } from "../opportunities/requirement-rules";

export interface TaskTerm {
  id: string;
  label: string;
  /** Normalised phrases (see normalizeLine: lower case, hyphens to spaces). Explicit forms only. */
  phrases: string[];
}

/** Explicit synonyms only. A form not listed here is simply not recognised; it is never guessed. */
export const TASK_TERMS: TaskTerm[] = [
  { id: "installation", label: "installation", phrases: ["install", "installs", "installed", "installing", "installation", "installations"] },
  { id: "startup", label: "startup", phrases: ["startup", "startups", "start up", "start ups", "started up", "starting up", "starts up"] },
  { id: "commissioning", label: "commissioning", phrases: ["commission", "commissioned", "commissioning"] },
  { id: "brazing", label: "brazing", phrases: ["braze", "brazed", "brazes", "brazing"] },
  { id: "soldering", label: "soldering", phrases: ["solder", "soldered", "soldering"] },
  { id: "pressure_testing", label: "pressure testing", phrases: ["pressure test", "pressure tests", "pressure tested", "pressure testing"] },
  { id: "leak_testing", label: "leak testing", phrases: ["leak test", "leak tests", "leak tested", "leak testing", "leak check", "leak checks", "leak checked", "leak checking"] },
  {
    id: "evacuation",
    label: "evacuation",
    phrases: ["evacuate", "evacuated", "evacuating", "evacuation", "pull vacuum", "pulled vacuum", "pulling vacuum", "pulled a vacuum", "pulling a vacuum", "vacuuming", "vacuumed"],
  },
  {
    id: "refrigerant_charging",
    label: "refrigerant charging",
    phrases: ["refrigerant charging", "charging", "charged", "charge refrigerant", "charged refrigerant", "refrigerant charge", "recharge", "recharged", "recharging"],
  },
  { id: "refrigerant_recovery", label: "refrigerant recovery", phrases: ["refrigerant recovery", "recover refrigerant", "recovered refrigerant", "recovering refrigerant"] },
  { id: "line_sets", label: "line sets", phrases: ["line set", "line sets", "lineset", "linesets"] },
  { id: "ductwork", label: "ductwork", phrases: ["ductwork", "duct work", "ducting"] },
  { id: "condensate", label: "condensate lines", phrases: ["condensate", "condensate line", "condensate lines", "condensate drain", "condensate drains"] },
  { id: "low_voltage_wiring", label: "low-voltage wiring", phrases: ["low voltage wiring", "low voltage"] },
  { id: "change_outs", label: "system change-outs", phrases: ["change out", "change outs", "changeout", "changeouts", "changed out", "replacement", "replacements"] },
  { id: "troubleshooting", label: "troubleshooting", phrases: ["troubleshoot", "troubleshoots", "troubleshooting", "troubleshot", "diagnose", "diagnosed", "diagnosing", "diagnostics"] },
  { id: "maintenance", label: "maintenance", phrases: ["maintenance", "tune up", "tune ups"] },
];

/** Context words that carry no task of their own. Anything else left over is reported as unchecked wording. */
const CONTEXT = new Set(
  (
    "a an the and or of in on with for to as well including include includes such experience experienced proficiency proficient " +
    "ability able knowledge skill skills skilled hands strong solid good working work performing perform performed familiarity familiar " +
    "system systems equipment unit units hvac residential commercial heat pump pumps furnace furnaces air conditioner conditioners ac " +
    "mini split splits ductless ducted handler handlers condenser condensers boiler boilers refrigerant refrigerants new existing all " +
    "complete completing proper properly safe safely , either"
  ).split(" "),
);

const phraseRe = (p: string) => new RegExp(`(?:^| )${p.replace(/ /g, " ")}(?= |$)`, "g");

interface Hit {
  term: TaskTerm;
  start: number;
  end: number;
}

/** Longest phrase wins where two overlap ("pressure testing" beats "testing"; "refrigerant charging" beats "charging"). */
function findTasks(norm: string): Hit[] {
  const all: Hit[] = [];
  for (const term of TASK_TERMS) {
    for (const p of term.phrases) {
      for (const m of norm.matchAll(phraseRe(p))) {
        const start = m.index! + (m[0].startsWith(" ") ? 1 : 0);
        all.push({ term, start, end: start + p.length });
      }
    }
  }
  all.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
  const kept: Hit[] = [];
  for (const h of all) if (!kept.some((k) => h.start < k.end && k.start < h.end)) kept.push(h);
  return kept.sort((a, b) => a.start - b.start);
}

/** Recognised task parts of a requirement line, in order, with the line's AND/OR meaning. */
export function splitTaskParts(originalText: string): { parts: TaskTerm[]; connector: TaskBreakdown["connector"]; uncoveredWording: boolean } | null {
  const norm = normalizeLine(originalText);
  const hits = findTasks(norm);
  const parts: TaskTerm[] = [];
  for (const h of hits) if (!parts.includes(h.term)) parts.push(h.term);
  if (!parts.length) return null;

  // Meaning comes from the connector before the LAST listed part: "a, b and c" = all; "a, b or c" = any;
  // "and/or" = any (at least one). A single part is just that part.
  let connector: TaskBreakdown["connector"] = "single";
  if (parts.length > 1) {
    const lastStart = hits.filter((h) => h.term === parts[parts.length - 1]).map((h) => h.start)[0];
    const prevEnd = Math.max(...hits.filter((h) => h.start < lastStart).map((h) => h.end));
    const gap = ` ${norm.slice(prevEnd, lastStart)} `;
    connector = /\b(?:or|either)\b/.test(gap) ? "any" : "all";
  }

  let rest = norm;
  for (const h of [...hits].sort((a, b) => b.start - a.start)) rest = `${rest.slice(0, h.start)} ${rest.slice(h.end)}`;
  const leftover = rest.split(" ").filter((w) => w && !CONTEXT.has(w) && !/^\d+$/.test(w));
  return { parts, connector, uncoveredWording: leftover.length > 0 };
}

/* ------------------------------------------------------------------ */
/* What a record's own wording says about one task                     */
/* ------------------------------------------------------------------ */

const NEGATED = /\b(?:not|never|no|without|didnt|wasnt|werent|couldnt|unable to)\b/;
const BY_OTHERS =
  /\b(?:by (?:another|other|others|a different|the other|a separate|a second|the lead|the senior|a sub|subcontractors?|someone|an? (?:electrician|helper|apprentice|lead|crew|technician|tech))|another (?:crew|tech|technician|installer|team)|other (?:crew|tech|technician|installer|team)|subcontracted|subbed out)\b/;
const ASSISTED = /\b(?:assist|assists|assisted|assisting|helped|helping|help with|observed|observing|shadowed|shadowing|watched|under supervision|supervised by|alongside)\b/;

const RANK: TaskPartStatus[] = ["documented", "assisted", "summary_only", "by_others", "negated", "not_found"];

/** Negation that applies to the task: up to 4 words before it ("did not braze"), or "not/never" just after it
 *  ("startup was not performed"). "Pressure tested, no leaks" is NOT a negated pressure test. */
const NEG_AFTER = /^(?: \S+){0,3} (?:not|never|wasnt|werent)\b/;

/** Split a record line into clauses so "installed; startup by another crew" judges each task by its own clause. */
const clauses = (s: string) => s.split(/[;.,]| but | while | however | although /i).map(normalizeLine).filter(Boolean);

function clauseStatus(term: TaskTerm, clause: string): TaskPartStatus | null {
  for (const p of term.phrases) {
    for (const m of clause.matchAll(phraseRe(p))) {
      const start = m.index! + (m[0].startsWith(" ") ? 1 : 0);
      const before = clause.slice(0, start).trim().split(" ").slice(-4).join(" ");
      const after = clause.slice(start + p.length);
      if (NEGATED.test(before) || NEG_AFTER.test(after)) return "negated";
      if (BY_OTHERS.test(clause)) return "by_others";
      if (ASSISTED.test(clause)) return "assisted";
      return "documented";
    }
  }
  return null;
}

/** One record's status for one task. Headline lines (title, skills, work performed) are judged clause by clause. */
export function recordTaskStatus(term: TaskTerm, e: Evidence): TaskPartStatus {
  const has = (s: string) => term.phrases.some((p) => phraseRe(p).test(s));
  const d = e.structuredData;
  const statuses = [e.title, ...d.skills, ...d.activities].flatMap(clauses).map((c) => clauseStatus(term, c)).filter((s): s is TaskPartStatus => s !== null);
  if (statuses.length) return statuses.sort((a, b) => RANK.indexOf(a) - RANK.indexOf(b))[0];
  const secondary = normalizeLine([d.summary ?? "", ...d.equipment].join(" . "));
  return has(secondary) ? "summary_only" : "not_found";
}

const PHRASE: Record<TaskPartStatus, (labels: string) => string> = {
  documented: (l) => `${l} documented`,
  assisted: (l) => `${l}: assisted or observed only`,
  by_others: (l) => `${l}: done by someone else, according to the record`,
  negated: (l) => `${l}: the record says it was not done`,
  summary_only: (l) => `${l}: mentioned only in a record's summary`,
  not_found: (l) => `${l} not established`,
};

const listJoin = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Task breakdown of a line against the technician's related records, or null when it names no recognised task. */
export function taskBreakdown(originalText: string, records: Evidence[]): TaskBreakdown | null {
  const split = splitTaskParts(originalText);
  if (!split) return null;
  const parts: TaskPart[] = split.parts.slice(0, 12).map((term) => {
    const per = records.map((e) => ({ e, s: recordTaskStatus(term, e) }));
    const best = per.map((x) => x.s).sort((a, b) => RANK.indexOf(a) - RANK.indexOf(b))[0] ?? "not_found";
    return { id: term.id, label: term.label, status: best, evidenceIds: best === "not_found" ? [] : per.filter((x) => x.s === best).map((x) => x.e.id).slice(0, 10) };
  });
  const groups = RANK.map((s) => ({ s, labels: parts.filter((p) => p.status === s).map((p) => p.label) })).filter((g) => g.labels.length);
  const body = groups.map((g) => PHRASE[g.s](listJoin(g.labels))).join("; ");
  const prefix = split.connector === "any" ? "The line accepts any one of these. " : "";
  const tail = split.uncoveredWording ? " Other wording in the line is not checked here." : "";
  return { connector: split.connector, parts, uncoveredWording: split.uncoveredWording, sentence: `${prefix}${cap(body)}.${tail}`.slice(0, 600) };
}

/** Task terms named anywhere in a piece of text (used to check AI-written text against the breakdown). */
export function tasksIn(text: string): TaskTerm[] {
  return [...new Set(findTasks(normalizeLine(text)).map((h) => h.term))];
}

/** The most supportive status any of these records gives a task (same ranking as the breakdown). */
export function bestTaskStatus(term: TaskTerm, records: Evidence[]): TaskPartStatus {
  return records.map((e) => recordTaskStatus(term, e)).sort((a, b) => RANK.indexOf(a) - RANK.indexOf(b))[0] ?? "not_found";
}
