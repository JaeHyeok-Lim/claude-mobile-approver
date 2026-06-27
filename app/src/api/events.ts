// Live feed data access: fetch recent events and map the bridge's EventDto down
// to the frozen FeedEvent UI shape, formatting the ISO timestamp into the
// compact clock label EventRow expects.

import type { FeedEvent } from "../components";
import { bridgeRequest } from "./client";
import type { EventDto, EventsResponse } from "./types";

export async function fetchEvents(signal?: AbortSignal): Promise<FeedEvent[]> {
  const data = await bridgeRequest<EventsResponse>("/events", { signal });
  return data.events.map(toFeedEvent);
}

function toFeedEvent(dto: EventDto): FeedEvent {
  return {
    id: dto.id,
    kind: dto.kind,
    message: dto.message,
    severity: dto.severity,
    source: dto.source,
    timeLabel: clockLabel(dto.createdAt)
  };
}

// "HH:MM" in the device's local zone. Falls back to the raw string if unparsable
// so a malformed timestamp never crashes the row.
export function clockLabel(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) {
    return at;
  }
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}
