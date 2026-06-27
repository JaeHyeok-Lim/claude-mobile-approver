import React from "react";
import { StyleSheet, View } from "react-native";
import { colors, radius, spacing } from "../theme";

type Tone = "default" | "allow" | "deny" | "pending";

// Card — bordered container for one logical item (an approval request, an event
// group). Tone tints the border + background to signal status without relying
// on color alone (paired with a Badge label by callers).
export function Card({
  children,
  tone = "default"
}: {
  children: React.ReactNode;
  tone?: Tone;
}) {
  return <View style={[styles.base, TONE[tone]]}>{children}</View>;
}

const TONE: Record<Tone, object> = {
  default: { borderColor: colors.border, backgroundColor: colors.surface },
  allow: { borderColor: colors.borderAccent, backgroundColor: colors.surfaceAllowSoft },
  deny: { borderColor: colors.borderDanger, backgroundColor: colors.surfaceDenySoft },
  pending: { borderColor: colors.pending, backgroundColor: colors.surfacePendingSoft }
};

const styles = StyleSheet.create({
  base: {
    padding: spacing.xxl,
    gap: spacing.xl,
    borderWidth: 1,
    borderRadius: radius.sm
  }
});
