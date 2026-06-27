// Registers the device's Expo push token with the bridge once on mount, and
// wires the notification-tap handler that pulls the operator to the inbox.
// Mirrors a reference Expo app. Best-effort: push is a
// convenience to surface a pending approval — the inbox poll is the source of
// truth, so failures here are swallowed and never block the UI.

import { useEffect } from "react";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { EAS_PROJECT_ID, registerPushToken } from "../api";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false
  })
});

// onApprovalTap fires when the user taps a push that carries an approval. The
// app shell uses it to switch to the Approvals tab.
export function usePushRegistration(onApprovalTap: () => void): void {
  useEffect(() => {
    void registerForPush().catch(() => undefined);

    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data;
      // Bridge tags approval pushes so the tap deep-links to the inbox.
      if (data?.kind === "approval" || data?.requestId) {
        onApprovalTap();
      }
    });

    return () => sub.remove();
  }, [onApprovalTap]);
}

async function registerForPush(): Promise<void> {
  if (!Device.isDevice) {
    return;
  }

  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("approvals", {
      name: "승인 요청",
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250]
    });
  }

  const current = await Notifications.getPermissionsAsync();
  const permission =
    current.status === "granted" ? current : await Notifications.requestPermissionsAsync();

  if (permission.status !== "granted") {
    return;
  }

  const projectId =
    EAS_PROJECT_ID ??
    Constants.easConfig?.projectId ??
    Constants.expoConfig?.extra?.eas?.projectId;

  if (!projectId) {
    return;
  }

  const token = await Notifications.getExpoPushTokenAsync({ projectId });
  await registerPushToken(token.data, Platform.OS === "ios" ? "ios" : "android");
}
