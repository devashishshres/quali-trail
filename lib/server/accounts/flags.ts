export const supervisorReviewEnabled = (env: NodeJS.ProcessEnv = process.env) => env.SUPERVISOR_REVIEW_ENABLED === "true";
