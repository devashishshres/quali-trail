import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { deliver } from "@/lib/server/email/deliver";
import { templates } from "@/lib/server/email/templates";
import { appBaseUrl } from "./service";

const DECISION_LABEL: Record<string, string> = {
  acknowledged: "acknowledged the description",
  correction_requested: "asked for a correction",
  declined: "said they can't confirm it",
};

/** After a customer decision: a receipt to the customer and a notice to the worker. Failures never undo the decision. */
export async function notifyCustomerDecision(r: { requestId: string; workerId: string; status: string; title: string; workerName: string; deliveryMode: string }) {
  const admin = createAdminClient();
  const base = appBaseUrl();
  const mock = r.deliveryMode === "mock";
  const label = DECISION_LABEL[r.status] ?? r.status;
  const { data: req } = await admin.from("signoff_requests").select("customer_email").eq("id", r.requestId).maybeSingle<{ customer_email: string | null }>();
  if (req?.customer_email) {
    await deliver({
      kind: "customer_receipt",
      to: req.customer_email,
      rendered: templates.customerReceipt({ base, mock, workerName: r.workerName, decisionLabel: label }),
      idempotencyKey: `receipt-${r.requestId}`,
      related: { type: "signoff_request", id: r.requestId },
      workerId: r.workerId,
    });
  }
  const workerEmail = await workerEmailOf(r.workerId);
  if (workerEmail) {
    await deliver({
      kind: "decision_notice",
      to: workerEmail,
      rendered: templates.decisionNotice({ base, mock, who: "customer", title: r.title, decisionLabel: label, link: `${base}/evidence` }),
      idempotencyKey: `notice-${r.requestId}`,
      related: { type: "signoff_request", id: r.requestId },
      workerId: r.workerId,
    });
  }
}

export async function workerEmailOf(workerId: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data: w } = await admin.from("workers").select("auth_user_id").eq("id", workerId).maybeSingle<{ auth_user_id: string }>();
  if (!w) return null;
  const { data } = await admin.auth.admin.getUserById(w.auth_user_id);
  return data.user?.email ?? null;
}
