/**
 * Deterministic requirement rules for IMPORTED job postings. PURE: no I/O, no model, no clock.
 *
 * The model never writes rules. It only proposes verbatim requirement lines; this module decides, from the
 * employer's ORIGINAL wording, whether QualiTrail can assess a line automatically.
 *
 * Conservative by design:
 *   - Only explicit catalog phrases are supported (EPA 608 and its scopes, NATE, OSHA 10/30, heat-pump
 *     installation / startup / commissioning work, commissioning, brazing).
 *   - Every content word of the line must be covered by a recognised phrase or harmless filler. Anything left
 *     over (a qualifier, an object, a number) makes the line "review only".
 *   - Negation, alternatives ("or", "/", "equivalent"), durations and other non-documentary conditions are
 *     never decided automatically. They become `cannot_assess`.
 *   - Two phrases form an all-of rule only when joined by an explicit conjunction ("and", a comma, "as well
 *     as"). "with", "in", "for", "including" never split a line.
 *
 * Seeded and sample requirements carry no `rule`, so they evaluate exactly as before.
 */
import type { EvidenceType, RequirementCriteria, RequirementRule, ReviewReason, RuleCondition } from "@/lib/types";

/* ------------------------------------------------------------------ */
/* Normalisation                                                       */
/* ------------------------------------------------------------------ */

/** Lower case; hyphens/underscores to spaces; commas kept as their own token; other punctuation dropped. */
export function normalizeLine(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[-–—_]+/g, " ")
    .replace(/,/g, " , ")
    .replace(/[^a-z0-9,' ]+/g, " ")
    .replace(/'s\b/g, "s")
    .replace(/'/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/* ------------------------------------------------------------------ */
/* Things QualiTrail never decides from records                        */
/* ------------------------------------------------------------------ */

const REVIEW_DETECTORS: [ReviewReason, RegExp][] = [
  ["duration", /\b\d+\s*\+?\s*(?:years?|yrs?|months?|mos?)\b|\b(?:one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:\+\s*)?(?:years?|months?)\b|\bminimum of\b|\bat least\b|\bseasons?\b/],
  ["driving", /\bdriv(?:er|ers|ing)\b|\blicen[cs]e to drive\b|\bmvr\b|\bown (?:vehicle|truck|transportation)\b|\breliable transportation\b|\bcdl\b/],
  ["work_authorization", /\bauthori[sz]ed to work\b|\bwork authori[sz]ation\b|\beligible to work\b|\bvisa\b|\bsponsorship\b|\bcitizen(?:ship)?\b|\bi 9\b/],
  ["physical", /\blift(?:ing)?\b|\bpounds\b|\blbs?\b|\bclimb(?:ing)?\b|\bladders?\b|\bcrawl\b|\bkneel\b|\bbend(?:ing)?\b|\bstand(?:ing)? for\b|\bphysical(?:ly)?\b|\battics?\b/],
  ["background_check", /\bbackground\b|\bdrug\b|\bscreen(?:ing)?\b|\bfelon(?:y|ies)\b|\bcriminal\b/],
  ["education", /\bhigh school\b|\bdiploma\b|\bged\b|\bdegree\b|\bassociates?\b|\bbachelors?\b|\btrade school\b|\bvocational\b|\bcollege\b|\bgraduate\b/],
  ["schedule", /\bon call\b|\bweekends?\b|\bovertime\b|\bshifts?\b|\bevenings?\b|\bholidays?\b|\btravel\b|(?<!\d )\bhours\b|\bschedule\b|\bfull time\b|\bpart time\b/],
];

const NEGATION = /\b(?:no|not|never|without|non|none|nor|neither)\b/;
const ALTERNATIVE_WORDS = /\b(?:or|either|equivalent|comparable|similar|alternative|alternatively)\b/;

/* ------------------------------------------------------------------ */
/* Catalog                                                             */
/* ------------------------------------------------------------------ */

const CERT_DOC: EvidenceType[] = ["certification"];
const WORK_DOC: EvidenceType[] = ["work_record", "checklist"];
const INSTALL = ["install", "installed", "installing", "installation", "installations", "installs"];
const STARTUP = ["start up", "startup", "startups", "started up", "starting up"];
const COMMISSION = ["commission", "commissioned", "commissioning"];
const HEAT_PUMP = ["heat pump", "heat pumps"];

const SCOPE = "(?:type (?:iii|ii|i|1|2|3)|universal|core)";
const CERT_WORD = "(?:certification|certificate|certified|card|credential|license|licence)";

type Match = { start: number; end: number; conditions: RuleCondition[]; review?: ReviewReason };

interface CatalogEntry {
  id: string;
  /** Global regex over the normalised line. Each hit is a covered span. */
  span: RegExp;
  /** Turn one covered span into conditions, or a review reason when the span itself is not decidable. */
  build(span: string): { conditions: RuleCondition[] } | { review: ReviewReason };
}

const cond = (c: Omit<RuleCondition, "supportingTypes" | "requiredFields" | "termGroups"> & Partial<RuleCondition>): RuleCondition => ({
  supportingTypes: [],
  requiredFields: [],
  termGroups: [],
  ...c,
});

function epaFromSpan(span: string): { conditions: RuleCondition[] } | { review: ReviewReason } {
  if (!/\b608\b/.test(span) && !(/\bepa\b/.test(span) && /\b(?:universal|type)\b/.test(span))) return { review: "unsupported_wording" };
  // Universal is the combination of Types I, II and III, so "Type II or Universal" is exactly the Type II
  // condition. That one pairing is the only alternative QualiTrail resolves; any other mix goes to review.
  const pair = /\btype (?:ii|2) or universal\b|\buniversal or type (?:ii|2)\b/;
  const s = span.replace(pair, "type ii");
  const scopes = new Set<string>();
  for (const m of s.matchAll(/\btype (iii|ii|i|1|2|3)\b|\b(universal)\b|\b(core)\b/g)) {
    const v = m[2] ?? m[3] ?? { "1": "i", "2": "ii", "3": "iii" }[m[1]] ?? m[1];
    scopes.add(v);
  }
  if (/\bor\b/.test(s)) return { review: "alternatives" };
  if (scopes.size > 1 || scopes.has("core")) return { review: "unsupported_wording" };
  const base = { acceptedTypes: CERT_DOC, keywords: ["EPA", "608"], requiredFields: ["issuer" as const] };
  const scope = [...scopes][0];
  const label = (s: string) => `EPA Section 608 certification${s}`;
  const q = "EPA Section 608 refrigerant handling technician certification";
  if (!scope) return { conditions: [cond({ ...base, id: "epa608", label: label(""), termGroups: [["608"]], retrievalQuery: q })] };
  if (scope === "universal") return { conditions: [cond({ ...base, id: "epa608_universal", label: label(" (Universal)"), termGroups: [["608"], ["universal"]], retrievalQuery: `${q} Universal` })] };
  const roman = scope as "i" | "ii" | "iii";
  const digit = { i: "1", ii: "2", iii: "3" }[roman];
  return {
    conditions: [
      cond({
        ...base,
        id: `epa608_type${digit}`,
        label: label(` (Type ${roman.toUpperCase()} or Universal)`),
        termGroups: [["608"], [`type ${roman}`, `type ${digit}`, "universal"]],
        retrievalQuery: `${q} Type ${roman.toUpperCase()}`,
      }),
    ],
  };
}

function heatPumpWork(span: string): { conditions: RuleCondition[] } | { review: ReviewReason } {
  const out: RuleCondition[] = [];
  const residential = /\bresidential\b/.test(span);
  const groups = (verb: string[]) => [HEAT_PUMP, verb, ...(residential ? [["residential", "home", "homes", "house", "single family"]] : [])];
  const where = residential ? "residential heat-pump" : "heat-pump";
  if (/\binstall/.test(span)) {
    out.push(cond({ id: "hp_install", label: `Documented ${where} installation work`, acceptedTypes: WORK_DOC, supportingTypes: ["training"], keywords: ["heat pump", "install"], termGroups: groups(INSTALL), requiredFields: ["date"], retrievalQuery: `${where} installation work record` }));
  }
  if (/\bstart(?:ing|ed)? ?up\b|\bstartup\b/.test(span)) {
    out.push(cond({ id: "hp_startup", label: `Documented ${where} startup work`, acceptedTypes: WORK_DOC, supportingTypes: ["training"], keywords: ["heat pump", "startup", "start up"], termGroups: groups(STARTUP), requiredFields: ["date"], retrievalQuery: `${where} startup work record` }));
  }
  if (/\bcommissioning\b/.test(span)) {
    out.push(cond({ id: "hp_commissioning", label: `Documented ${where} commissioning`, acceptedTypes: WORK_DOC, supportingTypes: ["training"], keywords: ["heat pump", "commissioning"], termGroups: groups(COMMISSION), requiredFields: ["date"], retrievalQuery: `${where} commissioning checklist work record` }));
  }
  return out.length ? { conditions: out } : { review: "unsupported_wording" };
}

const HP = "(?:residential )?(?:air source |ducted |ductless |mini split |split system )?heat pumps?(?: systems?| equipment| units?)?";
const VERBS = "(?:installing|installation|install|starting up|start up|startup|commissioning)";
const VERB_LIST = `${VERBS}(?: (?:and|,) ${VERBS})*`;

export const CATALOG: CatalogEntry[] = [
  {
    id: "epa608",
    span: new RegExp(
      `(?:(?:${SCOPE}) )?(?:us )?(?:epa|section 608)(?: section)?(?: 608)?(?: (?:refrigerant|refrigeration)(?: handling)?)?(?: technician)?(?: ${SCOPE}(?: (?:or|and|,) ${SCOPE})*)?(?: ${CERT_WORD})?(?: ${SCOPE}(?: (?:or|and|,) ${SCOPE})*)?(?: ${CERT_WORD})?`,
      "g",
    ),
    build: epaFromSpan,
  },
  {
    id: "nate",
    span: new RegExp(`(?:nate|north american technician excellence)(?: nate)?(?: ${CERT_WORD})?`, "g"),
    build: () => ({
      conditions: [cond({ id: "nate", label: "NATE certification", acceptedTypes: CERT_DOC, keywords: ["NATE", "North American Technician Excellence"], termGroups: [["nate", "north american technician excellence"]], requiredFields: ["issuer"], retrievalQuery: "NATE North American Technician Excellence certification" })],
    }),
  },
  {
    id: "osha",
    span: new RegExp(`osha (?:10|30)(?: hours?)?(?: (?:safety ))?(?: (?:training|card|course|${CERT_WORD}))?`, "g"),
    build: (span) => {
      const n = /\bosha 30\b/.test(span) ? "30" : "10";
      return {
        conditions: [cond({ id: `osha${n}`, label: `OSHA ${n}-hour training`, acceptedTypes: ["training", "certification"], keywords: ["OSHA"], termGroups: [[`osha ${n}`]], requiredFields: ["issuer"], retrievalQuery: `OSHA ${n} hour safety training card` })],
      };
    },
  },
  {
    id: "heat_pump_work",
    span: new RegExp(
      [
        `(?:(?:documented|proven|demonstrated|verifiable) )?(?:hands on )?experience (?:in |with )?(?:the )?${VERB_LIST}(?: of)? ${HP}`,
        `(?:(?:documented|proven|demonstrated|verifiable) )?(?:(?:hands on )?experience (?:in |with )?(?:the )?)?(?:hands on )?${HP} ${VERB_LIST}(?: work)?(?: experience)?`,
      ].join("|"),
      "g",
    ),
    build: heatPumpWork,
  },
  {
    id: "commissioning",
    span: /(?:(?:documented|proven|demonstrated) )?(?:(?:hands on )?experience (?:in |with )?)?(?:system )?commissioning(?: experience)?/g,
    build: () => ({
      conditions: [cond({ id: "commissioning", label: "Documented commissioning work", acceptedTypes: WORK_DOC, supportingTypes: ["training"], keywords: ["commissioning"], termGroups: [COMMISSION], requiredFields: ["date"], retrievalQuery: "HVAC system commissioning checklist work record" })],
    }),
  },
  {
    id: "brazing",
    span: /(?:(?:documented|proven|demonstrated) )?(?:(?:hands on )?experience (?:in |with )?)?brazing(?: (?:experience|skills?))?/g,
    build: () => ({
      conditions: [cond({ id: "brazing", label: "Documented brazing", acceptedTypes: ["work_record", "checklist", "training", "certification"], keywords: ["brazing", "brazed"], termGroups: [["braze", "brazed", "brazing"]], retrievalQuery: "brazing refrigerant line set work record training" })],
    }),
  },
];

/* ------------------------------------------------------------------ */
/* Coverage                                                            */
/* ------------------------------------------------------------------ */

/** Words that add nothing a record could show. Allowed outside recognised phrases. */
const FILLER = new Set([
  "a", "an", "the", "must", "have", "has", "hold", "holds", "holding", "possess", "possesses", "be", "is", "are", "will",
  "should", "current", "currently", "valid", "active", "up", "to", "date", "required", "require", "requires", "requirement",
  "mandatory", "need", "needed", "needs", "applicant", "applicants", "candidate", "candidates", "you", "your", "we", "of",
  "certification", "certified", "certificate", "with", ":", "in", "good", "standing",
]);
/** Allowed only when the line names exactly one recognised thing (otherwise they change the meaning of a compound). */
const PRIORITY_FILLER = new Set(["preferred", "plus", "bonus", "desired", "ideally", "ideal", "nice", "strongly", "highly", "is", "would", "be"]);
/** The only words allowed BETWEEN two recognised phrases. */
const CONJUNCTION = new Set(["and", ",", "as", "well", "plus", "also", "a", "an", "the", "valid", "current", "both"]);
/** Filler that must not join two phrases: "with", "in" and "of" never split a line. */
const NOT_BETWEEN = new Set(["with", "in", "of", "to", "up", "date", ":"]);

function overlaps(a: { start: number; end: number }, b: { start: number; end: number }) {
  return a.start < b.end && b.start < a.end;
}

/** Longest non-overlapping catalog hits, left to right. */
function findMatches(line: string): Match[] {
  const hits: Match[] = [];
  for (const entry of CATALOG) {
    for (const m of line.matchAll(entry.span)) {
      const text = m[0].trim();
      if (!text) continue;
      const start = m.index ?? 0;
      // Whole words only.
      const before = line[start - 1];
      const after = line[start + m[0].length];
      if ((before && /[a-z0-9]/.test(before)) || (after && /[a-z0-9]/.test(after))) continue;
      const built = entry.build(text);
      hits.push({ start, end: start + m[0].length, ...("review" in built ? { conditions: [], review: built.review } : { conditions: built.conditions }) });
    }
  }
  hits.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
  const chosen: Match[] = [];
  for (const h of hits) if (!chosen.some((c) => overlaps(c, h))) chosen.push(h);
  return chosen.sort((a, b) => a.start - b.start);
}

const words = (s: string) => s.split(" ").filter(Boolean);

export interface RuleAnalysis {
  rule: RequirementRule;
  criteria: RequirementCriteria;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n).trim() : s);

function criteriaFor(conditions: RuleCondition[], fallbackText: string): Omit<RequirementCriteria, "rule"> {
  if (conditions.length === 0) {
    const kw = [...new Set(words(normalizeLine(fallbackText)).filter((w) => w.length > 3 && !FILLER.has(w)))].slice(0, 8);
    return {
      acceptedTypes: ["other"],
      supportingTypes: [],
      keywords: kw.length ? kw : ["requirement"],
      retrievalQuery: clip(fallbackText.replace(/\s+/g, " ").trim(), 300) || "requirement",
      requiredFields: [],
    };
  }
  return {
    acceptedTypes: [...new Set(conditions.flatMap((c) => c.acceptedTypes))],
    supportingTypes: [...new Set(conditions.flatMap((c) => c.supportingTypes))],
    keywords: [...new Set(conditions.flatMap((c) => c.keywords))],
    retrievalQuery: clip(conditions.map((c) => c.retrievalQuery).join("; "), 300),
    requiredFields: [],
  };
}

/**
 * Decide how an imported requirement line is assessed. Input is the employer's ORIGINAL wording.
 * `manualReview` forces review-only (the technician chose "mark for manual review").
 */
export function analyzeRequirement(originalText: string, opts: { manualReview?: boolean } = {}): RuleAnalysis {
  const line = normalizeLine(originalText);
  const reasons = new Set<ReviewReason>();
  if (opts.manualReview) reasons.add("marked_by_technician");

  for (const [reason, re] of REVIEW_DETECTORS) if (re.test(line)) reasons.add(reason);
  if (NEGATION.test(line)) reasons.add("negation");
  if (/[/\\|]/.test(originalText) || /\band or\b/.test(line)) reasons.add("alternatives");

  const matches = findMatches(line);
  const conditions = matches.flatMap((m) => m.conditions);
  for (const m of matches) if (m.review) reasons.add(m.review);

  // "or" outside a span that resolved it (the EPA Type II / Universal pairing) is an alternative.
  const outside = matches.reduceRight((s, m) => s.slice(0, m.start) + " ".repeat(m.end - m.start) + s.slice(m.end), line);
  if (ALTERNATIVE_WORDS.test(outside)) reasons.add("alternatives");

  if (matches.length === 0) reasons.add("unsupported_wording");
  else {
    const single = matches.length === 1;
    // Leading / trailing words: filler only.
    const edges = [line.slice(0, matches[0].start), line.slice(matches[matches.length - 1].end)].flatMap(words);
    for (const w of edges) {
      if (FILLER.has(w) || (single && PRIORITY_FILLER.has(w))) continue;
      if (w === "and" || w === ",") continue;
      reasons.add(/\d/.test(w) ? "duration" : "unsupported_wording");
    }
    // Between phrases: an explicit conjunction is required, and nothing else.
    for (let i = 1; i < matches.length; i++) {
      const gap = words(line.slice(matches[i - 1].end, matches[i].start));
      const joined = gap.includes("and") || gap.includes(",") || gap.join(" ").includes("as well as");
      if (!joined || gap.some((w) => !CONJUNCTION.has(w) || NOT_BETWEEN.has(w))) reasons.add("unsupported_wording");
    }
    if (conditions.length > 4) reasons.add("unsupported_wording");
  }

  // Same condition twice ("EPA 608 and EPA 608 Universal") is not a clean all-of.
  const ids = conditions.map((c) => c.id);
  if (new Set(ids).size !== ids.length) reasons.add("unsupported_wording");

  if (reasons.size > 0) {
    const partial = conditions.slice(0, 4);
    const rule: RequirementRule = { kind: "review_only", reasons: [...reasons], partial };
    return { rule, criteria: { ...criteriaFor(partial, originalText), rule } };
  }
  const rule: RequirementRule = { kind: "supported", conditions };
  return { rule, criteria: { ...criteriaFor(conditions, originalText), rule } };
}

/** Plain-language reason, shown to the technician and on the report. Says nothing about the person. */
export const REVIEW_REASON_TEXT: Record<ReviewReason, string> = {
  unsupported_wording: "QualiTrail has no reliable rule for this wording, so it is not judged automatically.",
  alternatives: "The posting allows alternatives (such as \"or\", \"/\" or \"equivalent\"); QualiTrail does not choose between them.",
  negation: "The wording contains a negative condition, which records cannot show automatically.",
  duration: "It asks for a length of experience or a minimum amount; QualiTrail does not total time from records.",
  driving: "Driving or licence requirements are not checked from your records.",
  work_authorization: "Work authorization is between you and the employer; QualiTrail does not assess it.",
  physical: "Physical requirements are not assessed from records.",
  background_check: "Background or screening requirements are not assessed.",
  education: "Education requirements are outside the records QualiTrail assesses.",
  schedule: "Schedule and availability are not assessed from records.",
  marked_by_technician: "You marked this line for manual review.",
};
