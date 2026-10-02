import { describe, expect, it } from "vitest";
import {
  liveConnections,
  preferredConnection,
} from "../../extension/src/popupConnections";

describe("popup page selection", () => {
  const now = 1000;
  const connections = [
    { id: "stale", tab: 10, seen_at: now - 400 },
    { id: "closed", tab: 11, seen_at: now - 2 },
    { id: "background", tab: 12, seen_at: now - 1 },
    { id: "current", tab: 13, seen_at: now - 3 },
  ];

  it("omits expired and closed pages and prefers the current tab", () => {
    const live = liveConnections(connections, new Set([10, 12, 13]), now);
    expect(live.map((c) => c.id)).toEqual(["background", "current"]);
    expect(preferredConnection(live, 13)?.id).toBe("current");
  });

  it("keeps an explicit live selection and drops it after expiry", () => {
    const live = liveConnections(connections, new Set([12, 13]), now);
    expect(preferredConnection(live, 13, "background")?.id).toBe("background");
    expect(preferredConnection(live, 13, "stale")?.id).toBe("current");
  });
});
