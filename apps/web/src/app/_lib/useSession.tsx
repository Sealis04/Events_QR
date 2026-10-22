"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "./client";
import type { Me } from "./types";

/** The logged-in person and which server (VM or hub) is answering; sends anonymous visitors to /login. */
export function useSession(): { me: Me | undefined; error: string; reload: () => void } {
  const [me, setMe] = useState<Me>();
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      setMe(await api<Me>("/api/auth/me"));
      setError("");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) window.location.href = "/login";
      else if (err instanceof ApiError && err.code === "pin_change_required") setError("pin");
      else setError(err instanceof Error ? err.message : "failed to load");
    }
  }, []);
  useEffect(() => void load(), [load]);
  return { me, error, reload: load };
}
