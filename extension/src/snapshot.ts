import type { Snapshot } from "./types";
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
export function sameView(a: Partial<Snapshot>, b: Partial<Snapshot>): boolean {
  const keys = [
    "source",
    "account",
    "profile",
    "phase",
    "selection_epoch",
    "selected_key",
    "detail",
    "chat",
    "blocked",
    "list_signature",
    "send_ready",
    "contact_click_ready",
    "search_limited",
  ] as const;
  return keys.every(
    (key) =>
      JSON.stringify(canonical(a[key])) === JSON.stringify(canonical(b[key])),
  );
}
