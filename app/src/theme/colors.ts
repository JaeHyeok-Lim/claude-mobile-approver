// Color tokens. Palette mirrors a reference Expo app (warm paper + teal accent),
// extended with explicit semantic colors for the approval domain
// (allow = teal/green, deny = red, pending = amber). Light theme only,
// matching app.json userInterfaceStyle: "light".

export const colors = {
  // surfaces
  appBg: "#f4f1ea",
  surface: "#ffffff",
  surfaceMuted: "#ebe3d5",
  surfaceInverse: "#252a31",
  surfaceAllowSoft: "#e8f6f3",
  surfaceDenySoft: "#fbe9eb",
  surfacePendingSoft: "#fdf2dd",

  // borders
  border: "#d9d1c2",
  borderAccent: "#0f766e",
  borderDanger: "#ba3b46",

  // text
  text: "#181b20",
  textMuted: "#68717c",
  textSubtle: "#5c6470",
  textInverse: "#ffffff",
  textInverseMuted: "#c7d4d1",

  // brand / accent
  accent: "#0f766e",
  accentDark: "#074d47",
  accentOnInverse: "#7dd3c7",

  // semantic (approval domain)
  allow: "#0f766e",
  allowText: "#074d47",
  deny: "#ba3b46",
  denyText: "#8f2730",
  pending: "#b7791f",
  pendingText: "#7a4d10",

  // event-feed severity
  info: "#0f766e",
  warn: "#b7791f",
  error: "#ba3b46"
} as const;

export type ColorToken = keyof typeof colors;
