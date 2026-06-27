// Approval inbox data access: list pending requests and resolve one. Maps the
// bridge's ApprovalDto (a superset) down to the frozen ApprovalItem UI shape,
// computing the human countdown label from expiresAt (the bridge stays the sole
// authority on actual expiry; this label is display-only).

import type { ApprovalItem } from "../components";
import { bridgeRequest } from "./client";
import type { ApprovalDto, ApprovalsResponse, Decision, ResolveResponse } from "./types";

export async function fetchApprovals(signal?: AbortSignal): Promise<ApprovalItem[]> {
  const data = await bridgeRequest<ApprovalsResponse>("/approvals", { signal });
  return data.approvals.map(toApprovalItem);
}

export async function resolveApproval(
  requestId: string,
  decision: Decision
): Promise<ResolveResponse> {
  return bridgeRequest<ResolveResponse>(`/approvals/${encodeURIComponent(requestId)}/resolve`, {
    method: "POST",
    body: JSON.stringify({ decision })
  });
}

function toApprovalItem(dto: ApprovalDto): ApprovalItem {
  return {
    requestId: dto.requestId,
    tool: dto.tool,
    summary: dto.summary,
    cwd: dto.cwd,
    sessionLabel: dto.sessionId,
    status: dto.status,
    expiresInLabel:
      dto.status === "pending" ? expiresInLabel(dto.expiresAt) : undefined
  };
}

// "n분 m초" / "n초" until the bridge's expiresAt. Returns undefined if already
// past or missing — the card simply omits the countdown then.
export function expiresInLabel(expiresAt: string | undefined, now = Date.now()): string | undefined {
  if (!expiresAt) {
    return undefined;
  }
  const remainingMs = new Date(expiresAt).getTime() - now;
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    return undefined;
  }
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) {
    return `${minutes}분 ${seconds}초`;
  }
  return `${seconds}초`;
}
