import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { fieldErrors } from "@/lib/api/responses";
import { ConfirmEvidenceRequest } from "@/lib/types";

// The review form shows errors under keys like "fields.title" and
// "fields.structuredData.skills" (components/evidence/review-form.tsx).
it("keys confirm validation errors by the field the review form renders", () => {
  const parsed = ConfirmEvidenceRequest.safeParse({
    draftId: "d0000000-0000-4000-8000-000000000001",
    fields: {
      type: "checklist",
      title: "",
      date: null,
      issuer: null,
      structuredData: { skills: ["ok", "x".repeat(301)] },
    },
  });
  expect(parsed.success).toBe(false);
  const errors = fieldErrors(parsed.error!);
  expect(Object.keys(errors).sort()).toEqual(["fields.structuredData.skills", "fields.title"]);
});
