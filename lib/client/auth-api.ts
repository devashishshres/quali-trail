import { ApiRequestError } from "@/lib/client/errors";

/** JSON request to the app's own auth routes; errors become ApiRequestError with the server's safe message. */
export async function authRequest<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new ApiRequestError(json?.error?.code ?? "internal", res.status, json?.error?.message ?? "Something went wrong.", json?.error?.fieldErrors);
  return json as T;
}
