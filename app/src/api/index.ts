// Bridge data layer. Screens/hooks import from here, not the individual files.

export { BridgeError, bridgeRequest } from "./client";
export { BRIDGE_BASE_URL, BRIDGE_TOKEN, EAS_PROJECT_ID, POLL_INTERVAL_MS } from "./config";
export { fetchApprovals, resolveApproval, expiresInLabel } from "./approvals";
export { fetchEvents, clockLabel } from "./events";
export { registerPushToken } from "./register";
export type {
  ApprovalDto,
  ApprovalsResponse,
  Decision,
  ResolveResponse,
  EventDto,
  EventsResponse,
  RegisterResponse,
  BridgeErrorCode,
  BridgeErrorBody
} from "./types";
