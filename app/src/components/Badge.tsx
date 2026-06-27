import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { colors, fontSize, fontWeight, radius, spacing } from "../theme";

type Tone = "neutral" | "allow" | "deny" | "pending" | "info" | "warn" | "error";

// Badge — small status pill. Carries a text label so status is never conveyed
// by color alone (a11y). Used for request status (PENDING/ALLOWED/DENIED),
// tool name, and event severity.
export function Badge({ label, tone = "neutral" }: { label: string; tone?: Tone }) {
  return (
    <View style={[styles.pill, TONE[tone].box]}>
      <Text style={[styles.text, TONE[tone].text]}>{label}</Text>
    </View>
  );
}

const TONE: Record<Tone, { box: object; text: object }> = {
  neutral: { box: { backgroundColor: colors.surfaceMuted }, text: { color: colors.textSubtle } },
  allow: { box: { backgroundColor: colors.surfaceAllowSoft }, text: { color: colors.allowText } },
  deny: { box: { backgroundColor: colors.surfaceDenySoft }, text: { color: colors.denyText } },
  pending: { box: { backgroundColor: colors.surfacePendingSoft }, text: { color: colors.pendingText } },
  info: { box: { backgroundColor: colors.surfaceAllowSoft }, text: { color: colors.allowText } },
  warn: { box: { backgroundColor: colors.surfacePendingSoft }, text: { color: colors.pendingText } },
  error: { box: { backgroundColor: colors.surfaceDenySoft }, text: { color: colors.denyText } }
};

const styles = StyleSheet.create({
  pill: {
    minHeight: 30,
    paddingHorizontal: spacing.lg,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.pill
  },
  text: { fontSize: fontSize.caption, fontWeight: fontWeight.heavy }
});
