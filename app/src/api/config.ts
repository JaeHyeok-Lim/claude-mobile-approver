// Bridge connection config, read from EXPO_PUBLIC_* env (inlined at build time).
// The base URL already includes the /v1 prefix (see .env.example). Localhost
// will NOT resolve from a physical phone — use the desktop's LAN IP or the
// authenticated tunnel host.

// Env declaration kept here (not in a shared src/env.d.ts) so this slice owns it.
declare const process: {
  env: {
    EXPO_PUBLIC_BRIDGE_BASE_URL?: string;
    EXPO_PUBLIC_BRIDGE_TOKEN?: string;
    EXPO_PUBLIC_EAS_PROJECT_ID?: string;
  };
};

export const BRIDGE_BASE_URL =
  process.env.EXPO_PUBLIC_BRIDGE_BASE_URL?.trim() ?? "http://localhost:4318/v1";

export const BRIDGE_TOKEN = process.env.EXPO_PUBLIC_BRIDGE_TOKEN?.trim() ?? "";

export const EAS_PROJECT_ID = process.env.EXPO_PUBLIC_EAS_PROJECT_ID?.trim();

// Bounded long-poll for the live feed fallback / approval refresh, in ms.
export const POLL_INTERVAL_MS = 3000;
