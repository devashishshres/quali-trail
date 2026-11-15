import { getAccount } from "@/lib/api/auth";
import { apiError, ok } from "@/lib/api/responses";
import { supervisorReviewEnabled } from "@/lib/server/accounts/flags";
import { allowedRoles } from "@/lib/server/accounts/roles";
import { configProblems } from "@/lib/server/config";
import { importConfigProblems, importEnabled } from "@/lib/server/imports/config";
import { signoffEnabled } from "@/lib/server/signoff/config";
import type { MeResponse } from "@/lib/types";

/** GET /api/me — the caller's own roles, and which profiles they may still create. Never anyone else's. */
export async function GET() {
  const a = await getAccount();
  if (!a) return apiError("unauthorized", "Sign in first.");
  const configured = !configProblems().some((p) => p.name === "SIGNOFF_PEPPER");
  const may = configured ? await allowedRoles(a) : { worker: false, supervisor: false };
  return ok<MeResponse>({
    email: a.user.email,
    emailConfirmed: a.user.emailConfirmed,
    worker: a.worker ? { id: a.worker.id, name: a.worker.name } : null,
    supervisor: a.supervisor ? { name: a.supervisor.name, organization: a.supervisor.organization, title: a.supervisor.title } : null,
    canOnboard: may.worker || may.supervisor,
    canOnboardWorker: may.worker,
    canOnboardSupervisor: may.supervisor,
    features: { customerSignoff: signoffEnabled(), supervisorReview: supervisorReviewEnabled(), jobImport: importEnabled() && importConfigProblems().length === 0 },
  });
}
