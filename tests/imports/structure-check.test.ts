import { describe, expect, it } from "vitest";
import { buildDraft, isHeading, priorityFor } from "@/lib/server/imports/structure-check";
import { STUB_LISTINGS } from "@/lib/server/imports/tinyfish";
import { proposeWithStub } from "@/lib/server/imports/structure-check";
import { ImportDraft } from "@/lib/types/imports";

const LISTING = `# HVAC Installer (fictional)
Fictional Air Co. — Tempe, AZ

**Requirements:**
- EPA 608 Type II or Universal certification
* Valid driver’s license
1. 3+ years of experience

## Nice to have
- NATE certification

Benefits:
- Paid time off`;

const src = { text: LISTING, pageTitle: "HVAC Installer (fictional) | Jobs", sentTruncated: false, storedTruncated: false, kind: "listing_url" as const };

describe("buildDraft", () => {
  it("keeps verbatim lines with the listing's own characters and drops invented ones", () => {
    const { draft, warnings } = buildDraft(
      {
        title: "HVAC Installer (fictional)",
        employer: "Fictional Air Co.",
        location: "Tempe, AZ",
        incomplete: false,
        requirements: [
          { text: "EPA 608 Type II or Universal certification", category: "certification" },
          { text: "valid driver's license", category: "license" }, // case and apostrophe differ: still verbatim
          { text: "3+ years of experience.", category: "experience" },
          { text: "NATE certification", category: "certification" },
          { text: "OSHA 30 certification", category: "certification" }, // invented
          { text: "Must have 5 years experience", category: "experience" }, // reworded
        ],
      },
      src,
    );
    expect(ImportDraft.safeParse(draft).success).toBe(true);
    expect(draft.lines.map((l) => l.originalText)).toEqual(["EPA 608 Type II or Universal certification", "Valid driver’s license", "3+ years of experience", "NATE certification"]);
    expect(draft.failedLines).toBe(2);
    expect(warnings.join(" ")).toMatch(/2 lines .* could not be found word-for-word/);
    expect(draft.lines.map((l) => l.originalPriority)).toEqual(["required", "required", "required", "preferred"]);
    expect(draft.employer).toBe("Fictional Air Co.");
    expect(draft.location).toBe("Tempe, AZ");
  });

  it("never trusts model metadata that is not in the listing", () => {
    const { draft } = buildDraft({ title: "Senior Manager", employer: "Big Real Company Inc", location: "Mars", incomplete: false, requirements: [] }, src);
    expect(draft.title).toBe("HVAC Installer (fictional) | Jobs");
    expect(draft.employer).toBe("Employer not stated");
    expect(draft.location).toBeNull();
  });

  it("flags truncation, incompleteness, nothing found and pasted text", () => {
    const { warnings } = buildDraft({ title: null, employer: null, location: null, incomplete: true, requirements: [] }, { ...src, storedTruncated: true, kind: "pasted_text" });
    const w = warnings.join(" ");
    expect(w).toMatch(/cut off/);
    expect(w).toMatch(/looked incomplete/);
    expect(w).toMatch(/No requirement lines were found/);
    expect(w).toMatch(/supplied by you/);
  });

  it("duplicates are kept once", () => {
    const { draft } = buildDraft({ title: null, employer: null, location: null, incomplete: false, requirements: [{ text: "NATE certification", category: null }, { text: "NATE certification", category: null }] }, src);
    expect(draft.lines).toHaveLength(1);
  });
});

describe("priorityFor", () => {
  it.each([
    ["EPA 608", "requirements", "required"],
    ["EPA 608", "preferred qualifications", "preferred"],
    ["NATE certification is a plus", "requirements", "preferred"],
    ["Must hold EPA 608", null, "required"],
    ["EPA 608", "benefits", "unspecified"],
    ["EPA 608", null, "unspecified"],
  ])("%s under %s -> %s", (line, heading, expected) => expect(priorityFor(line, heading)).toBe(expected));
});

it("the local stub drafts the fictional listing deterministically and verbatim", () => {
  const l = STUB_LISTINGS["/hvac-tech"];
  const { draft } = buildDraft(proposeWithStub(l.text), { text: l.text, pageTitle: l.title, sentTruncated: false, storedTruncated: false, kind: "listing_url" });
  expect(draft.lines).toHaveLength(6);
  expect(draft.failedLines).toBe(0);
  expect(draft.lines.filter((x) => x.originalPriority === "preferred").map((x) => x.originalText)).toEqual(["NATE certification", "Brazing experience"]);
});

describe("priority from ordinary employer formatting (never guessed)", () => {
  it.each([
    // inline wording on the line itself
    ["EPA 608 Universal certification required.", null, "required"],
    ["Required: EPA 608 certification", null, "required"],
    ["Must have EPA 608 certification", null, "required"],
    ["NATE certification preferred", null, "preferred"],
    ["Preferred: NATE certification", null, "preferred"],
    ["NATE certification is a plus", "requirements", "preferred"], // the line's own words win over its section
    ["Brazing experience a plus but not required", "requirements", "preferred"],
    // not established -> unspecified
    ["College degree not required", "requirements", "unspecified"],
    ["EPA 608 required; NATE preferred", null, "unspecified"], // says both
    ["EPA 608 certification", null, "unspecified"],
    ["EPA 608 certification", "qualifications", "unspecified"], // a bare Qualifications heading doesn't say required
    ["EPA 608 certification", "skills", "unspecified"],
    ["EPA 608 certification", "required and preferred qualifications", "unspecified"],
    ["EPA 608 certification", "what we're looking for", "unspecified"],
    ["EPA 608 certification", "responsibilities", "unspecified"],
    // stated by the section
    ["EPA 608 certification", "requirements", "required"],
    ["EPA 608 certification", "minimum qualifications", "required"],
    ["EPA 608 certification", "what you'll need", "required"],
    ["EPA 608 certification", "preferred qualifications", "preferred"],
    ["EPA 608 certification", "nice to have", "preferred"],
    ["EPA 608 certification", "bonus points", "preferred"],
  ])("%s | heading %s -> %s", (line, heading, expected) => expect(priorityFor(line, heading)).toBe(expected));
});

describe("plain-text listing without Markdown", () => {
  const PLAIN = `HVAC Service Technician (fictional test listing)
Fictional Comfort Co. - Mesa, AZ

About the role
We install and service residential heat pumps. This listing is invented for a QualiTrail test.

Responsibilities
Install and start up heat pump systems

What you'll need:
EPA 608 Universal certification required.
Experience installing heat pumps
Valid driver's license

Nice to have:
NATE certification

Also:
OSHA 10 card preferred
Brazing experience

Benefits
Paid time off`;

  it("recognises plain headings from a fixed list only and reads priority from the listing", () => {
    const { draft, warnings } = buildDraft(proposeWithStub(PLAIN), { text: PLAIN, pageTitle: null, sentTruncated: false, storedTruncated: false, kind: "pasted_text" });
    expect(draft.lines.map((l) => [l.originalText, l.originalPriority])).toEqual([
      ["EPA 608 Universal certification required", "required"], // trailing punctuation is not kept
      ["Experience installing heat pumps", "required"],
      ["Valid driver's license", "required"],
      ["NATE certification", "preferred"],
      ["OSHA 10 card preferred", "preferred"],
      ["Brazing experience", "unspecified"], // "Also:" states no priority
    ]);
    expect(draft.title).toBe("HVAC Service Technician (fictional test listing)");
    expect(draft.employer).toBe("Fictional Comfort Co.");
    expect(draft.location).toBe("Mesa, AZ");
    expect(draft.failedLines).toBe(0);
    expect(warnings).toEqual(["This listing text was supplied by you, not retrieved from the employer's page."]);
  });

  it("short requirement lines are never mistaken for headings", () => {
    for (const l of ["NATE certification", "Brazing experience", "EPA 608", "OSHA 10", "Heat pumps"]) expect(isHeading(l)).toBeNull();
    for (const l of ["Qualifications", "REQUIREMENTS", "Preferred Qualifications", "Nice to have", "What you'll need"]) expect(isHeading(l)).not.toBeNull();
  });
});
