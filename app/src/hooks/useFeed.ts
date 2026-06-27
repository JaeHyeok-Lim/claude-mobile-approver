// Live feed state: polls the bridge's event feed (the mobile twin of the
// desktop dashboard). Polling is the v1 transport; the bridge's SSE/WS channel
// can swap in behind this same shape later. Read-only — the feed gates nothing.

import { useCallback, useEffect, useState } from "react";
import type { ConnectionState, FeedEvent } from "../components";
import { BridgeError, POLL_INTERVAL_MS, fetchEvents } from "../api";

interface FeedState {
  events: FeedEvent[];
  loaded: boolean;
  connection: ConnectionState;
  errorMessage?: string;
}

export function useFeed(): FeedState {
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [connection, setConnection] = useState<ConnectionState>("reconnecting");
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await fetchEvents(signal);
      if (signal?.aborted) {
        return;
      }
      setEvents(next);
      setConnection("live");
      setErrorMessage(undefined);
    } catch (error) {
      if (signal?.aborted) {
        return;
      }
      setConnection(error instanceof BridgeError && error.code === "network" ? "offline" : "reconnecting");
      setErrorMessage(error instanceof Error ? error.message : "피드를 불러오지 못했습니다.");
    } finally {
      if (!signal?.aborted) {
        setLoaded(true);
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const interval = setInterval(() => void load(controller.signal), POLL_INTERVAL_MS);
    return () => {
      controller.abort();
      clearInterval(interval);
    };
  }, [load]);

  return { events, loaded, connection, errorMessage };
}
