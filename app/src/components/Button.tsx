import React from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text } from "react-native";
import { colors, fontSize, fontWeight, radius, spacing } from "../theme";

type Variant = "primary" | "secondary" | "allow" | "deny";

// Button — single tappable action. Variants carry semantic color so Approve
// (allow) and Deny read at a glance. Always >= touchTarget tall (a11y).
// `loading` shows a spinner and blocks re-taps; `disabled` greys the action.
export function Button({
  label,
  onPress,
  variant = "primary",
  loading = false,
  disabled = false,
  accessibilityLabel
}: {
  label: string;
  onPress: () => void;
  variant?: Variant;
  loading?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
}) {
  const blocked = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: blocked, busy: loading }}
      disabled={blocked}
      onPress={onPress}
      style={[styles.base, VARIANT[variant].box, blocked && styles.blocked]}
    >
      {loading ? (
        <ActivityIndicator color={VARIANT[variant].spinner} />
      ) : (
        <Text style={[styles.label, VARIANT[variant].label]}>{label}</Text>
      )}
    </Pressable>
  );
}

const VARIANT: Record<
  Variant,
  { box: object; label: object; spinner: string }
> = {
  primary: {
    box: { backgroundColor: colors.accent },
    label: { color: colors.textInverse },
    spinner: colors.textInverse
  },
  secondary: {
    box: { backgroundColor: colors.surface },
    label: { color: colors.text },
    spinner: colors.text
  },
  allow: {
    box: { backgroundColor: colors.allow },
    label: { color: colors.textInverse },
    spinner: colors.textInverse
  },
  deny: {
    box: { backgroundColor: colors.deny },
    label: { color: colors.textInverse },
    spinner: colors.textInverse
  }
};

const styles = StyleSheet.create({
  base: {
    flex: 1,
    minHeight: spacing.touchTarget + 8,
    paddingHorizontal: spacing.xxl,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.sm
  },
  blocked: { opacity: 0.5 },
  label: { fontSize: fontSize.subtitle, fontWeight: fontWeight.heavy }
});
