import React from "react";
import { StyleSheet, Text, View } from "react-native";
import {
  ApprovalCard,
  ConnectionBanner,
  Screen,
  StateView
} from "../components";
import { colors, fontSize, fontWeight, spacing } from "../theme";
import { useApprovals } from "../hooks/useApprovals";

// ApprovalsScreen — the approval inbox: pending tool calls awaiting sign-off,
// each with Approve/Deny. Tapping resolves the bridge request, which unblocks
// the waiting PreToolUse hook on the desktop. Default-deny is enforced upstream
// (bridge TTL + hook timeout); this screen only surfaces the human decision.
export function ApprovalsScreen() {
  const { items, loaded, connection, errorMessage, resolving, resolve } = useApprovals();

  const pending = items.filter((item) => item.status === "pending");

  return (
    <Screen>
      <View style={styles.header}>
        <Text style={styles.brand}>Agent Bridge</Text>
        <Text style={styles.title}>승인함</Text>
      </View>

      <ConnectionBanner state={connection} />

      {!loaded ? (
        <StateView kind="loading" title="승인 요청을 불러오는 중…" />
      ) : items.length === 0 ? (
        <StateView
          kind={connection === "offline" ? "error" : "empty"}
          title={connection === "offline" ? "브릿지에 연결할 수 없습니다" : "대기 중인 요청이 없습니다"}
          detail={
            connection === "offline"
              ? errorMessage
              : "에이전트가 민감한 작업을 요청하면 여기로 도착합니다."
          }
        />
      ) : (
        items.map((item) => (
          <ApprovalCard
            key={item.requestId}
            item={item}
            resolving={resolving[item.requestId] ?? null}
            onApprove={(requestId) => void resolve(requestId, "allow")}
            onDeny={(requestId) => void resolve(requestId, "deny")}
          />
        ))
      )}

      {loaded && errorMessage && pending.length > 0 ? (
        <Text style={styles.error}>{errorMessage}</Text>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { paddingTop: spacing.md, paddingBottom: spacing.xs, gap: spacing.sm },
  brand: { color: colors.accent, fontSize: fontSize.label, fontWeight: fontWeight.bold },
  title: { color: colors.text, fontSize: fontSize.title, fontWeight: fontWeight.heavy },
  error: { color: colors.deny, fontSize: fontSize.label, fontWeight: fontWeight.bold }
});
