import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { colors, fontSize, fontWeight, spacing } from "../theme";

// KeyValue — labeled line for request metadata (cwd, session, requested-at).
// Value is monospace-ish heavy text; wraps for long redacted summaries.
export function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.value} numberOfLines={3}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { gap: spacing.xs },
  label: { color: colors.textMuted, fontSize: fontSize.label, fontWeight: fontWeight.bold },
  value: { color: colors.text, fontSize: fontSize.body, fontWeight: fontWeight.heavy }
});
