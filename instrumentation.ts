/**
 * Runs once when the server starts. Logs configuration problems by variable NAME and reason only (never values),
 * so a misconfigured deployment is obvious in the logs before anyone hits a failing route.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { configProblems, describeProblems } = await import("@/lib/server/config");
  const problems = configProblems();
  if (problems.length) console.warn(`[config] ${problems.length} problem(s): ${describeProblems(problems)}`);
}
