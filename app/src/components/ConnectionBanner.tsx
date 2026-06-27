import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { colors, fontSize, fontWeight, radius, spacing } from "../theme";

export type ConnectionState = "live" | "reconnecting" | "offline";

// ConnectionBanner — persistent status of the live channel (SSE/WS) to the
// bridge. Security-relevant: when offline, the user must understand the feed
// is stale AND that any pending request on the agent side will DEFAULT-DENY on
// timeout — never silently auto-approve. Hidden entirely while "live" to avoid
// chrome noise.
export function ConnectionBanner({ state }: { state: ConnectionState }) {
  if (state === "live") {
    return null;
  }
  const copy = COPY[state];
  return (
    <View style={[styles.bar, copy.box]} accessibilityRole="alert">
      <Text style={[styles.text, copy.text]}>{copy.label}</Text>
    </View>
  );
}

const COPY: Record<
  Exclude<ConnectionState, "live">,
  { label: string; box: object; text: object }
> = {
  reconnecting: {
    label: "브릿지에 다시 연결하는 중… 피드가 최신이 아닐 수 있어요.",
    box: { backgroundColor: colors.surfacePendingSoft },
    text: { color: colors.pendingText }
  },
  offline: {
    label:
      "브릿지 연결 끊김. 새 승인 요청을 받지 못하며, 대기 중인 요청은 시간 초과 시 자동 거부됩니다.",
    box: { backgroundColor: colors.surfaceDenySoft },
    text: { color: colors.denyText }
  }
};

const styles = StyleSheet.create({
  bar: {
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.xl,
    borderRadius: radius.sm
  },
  text: { fontSize: fontSize.label, fontWeight: fontWeight.heavy }
});
