// Spacing, radius, and font scale tokens. Values mirror the magic numbers used
// throughout a reference Expo app so the two apps feel like siblings.

export const spacing = {
  xs: 4,
  sm: 6,
  md: 8,
  lg: 10,
  xl: 14,
  xxl: 18,
  // tap-target floor; a reference app sizes interactive rows/buttons >= 56-64
  touchTarget: 56
} as const;

export const radius = {
  sm: 8,
  pill: 15,
  round: 32
} as const;

export const fontSize = {
  caption: 12,
  label: 13,
  body: 15,
  bodyLg: 16,
  subtitle: 18,
  value: 26,
  title: 30,
  hero: 46
} as const;

// React Native fontWeight literals used in a reference app (heavy by convention).
export const fontWeight = {
  bold: "800",
  heavy: "900"
} as const;

export type Spacing = keyof typeof spacing;
export type Radius = keyof typeof radius;
