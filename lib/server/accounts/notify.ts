import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { deliver, type DeliveryOutcome } from "@/lib/server/email/deliver";
import { emailMode } from "@/lib/server/email/config";
import { templates } from "@/lib/server/email/templates";
import { appBaseUrl } from "@/lib/server/signoff/service";
import { workerEmailOf } from "@/lib/server/signoff/notify";

export async function emailOfUser(authUserId: string): Promise<string | null> {
  const { data } = await createAdminClient().auth.admin.getUserById(authUserId);
  return data.user?.email ?? null;
}

/** Tell the supervisor a job is waiting. The link opens an authenticated page; it approves nothing. */
export async function notifyReviewRequested(o: { requestId: string; supervisorAuthUserId: string; workerName: string; workerId: string; attempt: number }): Promise<DeliveryOutcome> {
  const to = await emailOfUser(o.supervisorAuthUserId);
  if (!to) return { ok: false, reason: "failed" };
  const base = appBaseUrl();
  const link = `${base}/supervisor/reviews/${o.requestId}`;
  const mock = emailMode() === "mock";
  return deliver({
    kind: o.attempt === 0 ? "review_notification" : "reminder",
    to,
    rendered: o.attempt === 0
      ? templates.reviewNotification({ base, mock, workerName: o.workerName, link })
      : templates.reminder({ base, mock, workerName: o.workerName, link, what: "supervisor" }),
    idempotencyKey: `review-notify-${o.requestId}-${o.attempt}`,
    related: { type: "review_request", id: o.requestId },
    workerId: o.workerId,
  });
}

const LABEL: Record<string, string> = {
  confirmed_observed: "confirmed observing some of the tasks",
  confirmed_documents: "reviewed the supporting document",
  correction_requested: "asked for a correction",
  declined: "said they can't confirm it",
};

export async function notifyReviewDecided(o: { requestId: string; workerId: string; status: string; title: string }) {
  const to = await workerEmailOf(o.workerId);
  if (!to) return;
  const base = appBaseUrl();
  await deliver({
    kind: "decision_notice",
    to,
    rendered: templates.decisionNotice({ base, mock: emailMode() === "mock", who: "supervisor", title: o.title, decisionLabel: LABEL[o.status] ?? o.status, link: `${base}/evidence` }),
    idempotencyKey: `review-decided-${o.requestId}`,
    related: { type: "review_request", id: o.requestId },
    workerId: o.workerId,
  });
}
