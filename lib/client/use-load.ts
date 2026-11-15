"use client";
import { useCallback, useEffect, useState } from "react";
import { toApiError, type ApiRequestError } from "./errors";

export type LoadState<T> =
  | { status: "loading"; data?: undefined; error?: undefined }
  | { status: "ready"; data: T; error?: undefined }
  | { status: "error"; data?: T; error: ApiRequestError };

/**
 * Load data on mount and whenever `key` changes. `reload()` refetches but
 * keeps the previous data on screen, so polling doesn't flash.
 * ponytail: no request dedupe/cache — add SWR/React Query if pages start sharing data.
 */
export function useLoad<T>(load: () => Promise<T>, key: string = "") {
  const [state, setState] = useState<LoadState<T>>({ status: "loading" });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    Promise.resolve().then(load).then(
      (data) => live && setState({ status: "ready", data }),
      (e) => live && setState((prev) => ({ status: "error", data: prev.data, error: toApiError(e) })),
    );
    return () => {
      live = false;
    };
    // `load` is a fresh closure each render; `key` is the real dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible") reload(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [reload]);
  const setData = useCallback((data: T) => setState({ status: "ready", data }), []);
  return { ...state, reload, setData };
}
