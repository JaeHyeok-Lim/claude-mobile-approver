// Push-token registration with the bridge. The bridge sends an Expo push on each
// new approval request so the operator is pulled to the inbox.

import { bridgeRequest } from "./client";
import type { RegisterResponse } from "./types";

export async function registerPushToken(
  token: string,
  platform: "android" | "ios"
): Promise<RegisterResponse> {
  return bridgeRequest<RegisterResponse>("/register", {
    method: "POST",
    body: JSON.stringify({ expoPushToken: token, label: platform })
  });
}
