import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { EvidenceDraft } from "@/lib/types";
import { ReviewForm } from "@/components/evidence/review-form";

it("duplicate uploads lead to the existing record, never an unsaveable confirmation form", () => {
  const draft = EvidenceDraft.parse({
    draftId: "d0000000-0000-4000-8000-000000000001", sourceKind: "pdf_upload", fileName: "fictional.pdf",
    extraction: null, extractionError: null, duplicateOfEvidenceId: "e0000000-0000-4000-8000-000000000001",
    createdAt: "2026-11-14T17:00:00Z",
  });
  const markup = renderToStaticMarkup(createElement(ReviewForm, { draft, onSaved: () => {}, onDiscard: () => {} }));
  expect(markup).toContain("#evidence-e0000000-0000-4000-8000-000000000001");
  expect(markup).not.toContain("Save evidence");
  expect(markup).not.toContain("<form");
});
