// Expo push sender. Fire-and-forget best-effort: a push failure must NEVER affect the approval
// gate (the hook long-polls regardless; push is just a nudge to the operator). We send only a
// redacted title/body — never tool input.
//
// Expo Push API: POST { to, title, body, data } to https://exp.host/--/api/v2/push/send.
// https://docs.expo.dev/push-notifications/sending-notifications/

import type { DeviceStore } from "../store/deviceStore.js";

export interface PushMessage {
  title: string;
  body: string; // already redacted
  // Small routing payload the app uses to deep-link (e.g. to the approval inbox).
  data?: Record<string, string>;
}

export class ExpoPush {
  private readonly url: string;
  private readonly devices: DeviceStore;

  constructor(opts: { url: string; devices: DeviceStore }) {
    this.url = opts.url;
    this.devices = opts.devices;
  }

  // Returns void; logs (redacted) on failure but never throws.
  async send(message: PushMessage): Promise<void> {
    const tokens = this.devices.tokens();
    if (tokens.length === 0) return;

    const messages = tokens.map((to) => ({
      to,
      title: message.title,
      body: message.body,
      sound: "default",
      data: message.data ?? {}
    }));

    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      try {
        const res = await fetch(this.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json"
          },
          body: JSON.stringify(messages),
          signal: ctrl.signal
        });
        if (!res.ok) {
          console.warn(`[push] expo push returned ${res.status}`);
        }
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      // Network/timeout — never propagate. The gate does not depend on push delivery.
      console.warn(`[push] expo push failed: ${(err as Error)?.name ?? "error"}`);
    }
  }
}
