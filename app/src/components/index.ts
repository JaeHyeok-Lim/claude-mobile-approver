// Shared UI primitives for agent-mobile-bridge. Presentational only — no data
// fetching, no bridge calls. Screen files (owned by engineering) compose these
// and wire the resolve/poll/SSE behavior.

export { Screen } from "./Screen";
export { Button } from "./Button";
export { Card } from "./Card";
export { Badge } from "./Badge";
export { KeyValue } from "./KeyValue";
export { StateView } from "./StateView";
export { ConnectionBanner } from "./ConnectionBanner";
export type { ConnectionState } from "./ConnectionBanner";
export { ApprovalCard } from "./ApprovalCard";
export type { ApprovalItem, ApprovalStatus } from "./ApprovalCard";
export { EventRow } from "./EventRow";
export type { FeedEvent, EventSeverity } from "./EventRow";
