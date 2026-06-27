import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { colors, fontSize, fontWeight, spacing } from "../theme";
import { Badge } from "./Badge";

export type EventSeverity = "info" | "warn" | "error";

export interface FeedEvent {
  id: string;
  // e.g. "SubagentStop", "Notification", "PostToolUse", "Decision"
  kind: string;
  // REDACTED one-line summary — never full tool input.
  message: string;
  // pre-formatted clock label, e.g. "14:03"
  timeLabel: string;
  severity?: EventSeverity;
  // optional agent / session origin label
  source?: string;
}

// EventRow — one line in the live feed (the mobile twin of the desktop
// dashboard). Compact, scannable, severity-tagged. Read-only: the feed never
// gates anything, so there are no actions here.
export function EventRow({ event }: { event: FeedEvent }) {
  return (
    <View style={styles.row}>
      <View style={styles.head}>
        <Badge label={event.kind} tone={event.severity ?? "info"} />
        <Text style={styles.time}>{event.timeLabel}</Text>
      </View>
      <Text style={styles.message} numberOfLines={4}>
        {event.message}
      </Text>
      {event.source ? <Text style={styles.source}>{event.source}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    padding: spacing.xl,
    gap: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    backgroundColor: colors.surface
  },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  time: { color: colors.textMuted, fontSize: fontSize.caption, fontWeight: fontWeight.bold },
  message: { color: colors.text, fontSize: fontSize.body, fontWeight: fontWeight.bold },
  source: { color: colors.textMuted, fontSize: fontSize.caption, fontWeight: fontWeight.bold }
});
