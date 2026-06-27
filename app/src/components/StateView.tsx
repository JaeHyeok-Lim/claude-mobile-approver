import React from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { colors, fontSize, fontWeight, spacing } from "../theme";

// StateView — the non-content states every list screen needs: loading, empty,
// and error. Centralized so the two tabs render them identically.
// `kind="error"` is also used for the security-critical "connection lost"
// banner copy — when the bridge is unreachable the user must understand that
// pending requests will DEFAULT-DENY on timeout, not silently auto-approve.
export function StateView({
  kind,
  title,
  detail
}: {
  kind: "loading" | "empty" | "error";
  title: string;
  detail?: string;
}) {
  return (
    <View style={styles.wrap} accessibilityRole={kind === "error" ? "alert" : undefined}>
      {kind === "loading" ? <ActivityIndicator color={colors.accent} /> : null}
      <Text style={[styles.title, kind === "error" && styles.errorTitle]}>{title}</Text>
      {detail ? <Text style={styles.detail}>{detail}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    minHeight: 160,
    padding: spacing.xxl,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.lg
  },
  title: {
    textAlign: "center",
    color: colors.text,
    fontSize: fontSize.subtitle,
    fontWeight: fontWeight.heavy
  },
  errorTitle: { color: colors.deny },
  detail: {
    textAlign: "center",
    color: colors.textMuted,
    fontSize: fontSize.body,
    fontWeight: fontWeight.bold
  }
});
