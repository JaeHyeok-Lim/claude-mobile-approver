// Approval inbox state: polls the bridge for pending requests and exposes a
// resolve action. Polling (not just push) is the source of truth so a missed
// push never strands a request. Connection state is derived from poll outcomes
// so ConnectionBanner can warn the operator that pending requests will
// DEFAULT-DENY on the agent side while the bridge is unreachable.

import { useCallback, useEffect, useRef, useState } from "react";
import type { ApprovalItem } from "../components";
import type { ConnectionState } from "../components";
import { BridgeError, POLL_INTERVAL_MS, fetchApprovals, resolveApproval } from "../api";
import type { Decision } from "../api";

interface ApprovalsState {
  items: ApprovalItem[];
  // null until the first fetch settles (drives the loading state).
  loaded: boolean;
  connection: ConnectionState;
  errorMessage?: string;
  // requestId -> the decision currently being submitted, to disable buttons.
  resolving: Record<string, Decision>;
  resolve: (requestId: string, decision: Decision) => Promise<void>;
  refresh: () => void;
}

export function useApprovals(): ApprovalsState {
  const [items, setItems] = useState<ApprovalItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [connection, setConnection] = useState<ConnectionState>("reconnecting");
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);
  const [resolving, setResolving] = useState<Record<string, Decision>>({});
  const tick = useRef(0);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await fetchApprovals(signal);
      if (signal?.aborted) {
        return;
      }
      setItems(next);
      setConnection("live");
      setErrorMessage(undefined);
    } catch (error) {
      if (signal?.aborted) {
        return;
      }
      // A network error means the bridge is unreachable: go offline so the
      // banner makes the default-deny consequence explicit. Other (auth, etc.)
      // errors surface as a message but keep the last-known list.
      if (error instanceof BridgeError && error.code === "network") {
        setConnection("offline");
      } else {
        setConnection("reconnecting");
      }
      setErrorMessage(error instanceof Error ? error.message : "승인 목록을 불러오지 못했습니다.");
    } finally {
      if (!signal?.aborted) {
        setLoaded(true);
      }
    }
  }, []);

  // tick bumps force the polling effect to re-run an immediate fetch on refresh.
  const [, force] = useState(0);
  const refresh = useCallback(() => {
    tick.current += 1;
    force((n) => n + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const interval = setInterval(() => void load(controller.signal), POLL_INTERVAL_MS);
    return () => {
      controller.abort();
      clearInterval(interval);
    };
  }, [load, tick.current]);

  const resolve = useCallback(
    async (requestId: string, decision: Decision) => {
      setResolving((prev) => ({ ...prev, [requestId]: decision }));
      try {
        const result = await resolveApproval(requestId, decision);
        // Reflect the bridge's authoritative outcome immediately; a closed
        // request (allow/deny/expired/already_resolved) leaves the buttons gone.
        setItems((prev) =>
          prev.map((item) =>
            item.requestId === requestId ? { ...item, status: result.status } : item
          )
        );
        setErrorMessage(undefined);
      } catch (error) {
        // If the bridge already closed it (expired / already_resolved), reflect
        // that as denied-equivalent — NEVER silently treat a failed resolve as
        // an allow. A re-poll will reconcile the true state.
        if (
          error instanceof BridgeError &&
          (error.code === "expired" || error.code === "already_resolved")
        ) {
          setItems((prev) =>
            prev.map((item) =>
              item.requestId === requestId
                ? { ...item, status: error.code === "expired" ? "expired" : item.status }
                : item
            )
          );
        }
        setErrorMessage(error instanceof Error ? error.message : "결정을 전송하지 못했습니다.");
      } finally {
        setResolving((prev) => {
          const next = { ...prev };
          delete next[requestId];
          return next;
        });
      }
    },
    []
  );

  return { items, loaded, connection, errorMessage, resolving, resolve, refresh };
}
