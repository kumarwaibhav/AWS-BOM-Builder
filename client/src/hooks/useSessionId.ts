import { useState } from "react";
import { SESSION_STORAGE_KEY } from "@/const";

/** Stable per-browser id used to scope anonymous bill history. No accounts. */
export function useSessionId(): string {
  const [sessionId] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    let id = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!id) {
      id = `session-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
      localStorage.setItem(SESSION_STORAGE_KEY, id);
    }
    return id;
  });
  return sessionId;
}
