import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { colors, fontSize, fontWeight, spacing } from "../theme";
import { Badge } from "./Badge";
import { Button } from "./Button";
import { Card } from "./Card";
import { KeyValue } from "./KeyValue";

// Decision status as the bridge reports it. "expired" = TTL lapsed -> the hook
// will have / has already default-denied; the card shows it as a closed,
// denied-equivalent outcome and disables the action buttons.
export type ApprovalStatus = "pending" | "allow" | "deny" | "expired";

export interface ApprovalItem {
  requestId: string;
  tool: string;
  // REDACTED summary only — never the full tool input (may hold secrets).
  summary: string;
  cwd?: string;
  sessionLabel?: string;
  // Human-readable "n초/분 남음" countdown to TTL, computed by the caller.
  expiresInLabel?: string;
  status: ApprovalStatus;
}

// ApprovalCard — one pending tool call awaiting sign-off. The whole security
// model funnels through these two buttons, so the design biases toward a
// deliberate, unambiguous choice:
//   - Deny is presented first (left) and is the safe/default action.
//   - Buttons disable + show a spinner while the resolve POST is in flight, so
//     a double-tap can't fire a second decision.
//   - Once decided/expired, buttons are gone and a status Badge takes over.
// `resolving` is the button that is mid-request, if any.
export function ApprovalCard({
  item,
  onApprove,
  onDeny,
  resolving
}: {
  item: ApprovalItem;
  onApprove: (requestId: string) => void;
  onDeny: (requestId: string) => void;
  resolving?: "allow" | "deny" | null;
}) {
  const open = item.status === "pending";
  const tone =
    item.status === "allow" ? "allow" : item.status === "pending" ? "pending" : "deny";

  return (
    <Card tone={tone}>
      <View style={styles.head}>
        <Badge label={item.tool} tone="neutral" />
        <Badge label={STATUS_LABEL[item.status]} tone={STATUS_TONE[item.status]} />
      </View>

      <Text style={styles.summary}>{item.summary}</Text>

      {item.cwd ? <KeyValue label="작업 경로" value={item.cwd} /> : null}
      {item.sessionLabel ? <KeyValue label="세션" value={item.sessionLabel} /> : null}

      {open && item.expiresInLabel ? (
        <Text style={styles.expiry}>자동 거부까지 {item.expiresInLabel}</Text>
      ) : null}

      {open ? (
        <View style={styles.actions}>
          <Button
            label="거부"
            variant="deny"
            accessibilityLabel={`${item.tool} 요청 거부`}
            loading={resolving === "deny"}
            disabled={resolving === "allow"}
            onPress={() => onDeny(item.requestId)}
          />
          <Button
            label="승인"
            variant="allow"
            accessibilityLabel={`${item.tool} 요청 승인`}
            loading={resolving === "allow"}
            disabled={resolving === "deny"}
            onPress={() => onApprove(item.requestId)}
          />
        </View>
      ) : null}
    </Card>
  );
}

const STATUS_LABEL: Record<ApprovalStatus, string> = {
  pending: "대기 중",
  allow: "승인됨",
  deny: "거부됨",
  expired: "만료(자동 거부)"
};

const STATUS_TONE: Record<ApprovalStatus, "pending" | "allow" | "deny"> = {
  pending: "pending",
  allow: "allow",
  deny: "deny",
  expired: "deny"
};

const styles = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  summary: { color: colors.text, fontSize: fontSize.subtitle, fontWeight: fontWeight.heavy },
  expiry: { color: colors.pendingText, fontSize: fontSize.label, fontWeight: fontWeight.bold },
  actions: { flexDirection: "row", gap: spacing.lg }
});
