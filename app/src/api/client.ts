// Thin authenticated fetch wrapper for the bridge. Mirrors a reference app's
// apiRequest helper: every request carries the shared bearer token, JSON in /
// JSON out, and non-2xx bodies follow the bridge's { error, message? } envelope.

import { BRIDGE_BASE_URL, BRIDGE_TOKEN } from "./config";
import type { BridgeErrorBody, BridgeErrorCode } from "./types";

export class BridgeError extends Error {
  readonly code: BridgeErrorCode | "network";
  readonly status: number;

  constructor(code: BridgeErrorCode | "network", status: number, message: string) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.status = status;
  }
}

export async function bridgeRequest<T = unknown>(
  path: string,
  init?: RequestInit & { signal?: AbortSignal }
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BRIDGE_BASE_URL}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${BRIDGE_TOKEN}`,
        ...init?.headers
      }
    });
  } catch (error) {
    // Bridge unreachable / DNS / TLS / aborted: surface as a network error so
    // callers render the offline state rather than silently treating it as ok.
    throw new BridgeError(
      "network",
      0,
      error instanceof Error ? error.message : "브릿지에 연결할 수 없습니다."
    );
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as BridgeErrorBody | null;
    const code = body?.error ?? "internal";
    throw new BridgeError(code, response.status, body?.message ?? `요청 실패 (${response.status})`);
  }

  // 204 / empty body tolerated for fire-and-forget style endpoints.
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}
