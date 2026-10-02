export type PageConnection = {
  id: string;
  tab: number;
  seen_at: number;
};

export function liveConnections<T extends PageConnection>(
  connections: T[],
  openTabIds: ReadonlySet<number>,
  nowSeconds: number,
): T[] {
  return connections.filter(
    (c) =>
      openTabIds.has(c.tab) &&
      c.seen_at <= nowSeconds + 5 &&
      nowSeconds - c.seen_at < 25,
  );
}

export function preferredConnection<T extends PageConnection>(
  connections: T[],
  activeTabId: number | undefined,
  manuallySelectedId?: string,
): T | undefined {
  return (
    connections.find((c) => c.id === manuallySelectedId) ??
    connections.find((c) => c.tab === activeTabId) ??
    connections[0]
  );
}
