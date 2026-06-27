import React, { useCallback, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, fontSize, fontWeight, radius, spacing } from "../theme";
import { FeedScreen } from "../screens/FeedScreen";
import { ApprovalsScreen } from "../screens/ApprovalsScreen";
import { usePushRegistration } from "../hooks/usePushRegistration";

type Tab = "feed" | "approvals";

// App — root shell with a two-tab bottom bar (live feed + approval inbox).
// Kept to a hand-rolled tab switch (no react-navigation dependency) to mirror
// a reference app's lean screen-state approach — the app has exactly two surfaces.
// Tapping an approval push deep-links straight to the inbox tab.
export default function App() {
  const [tab, setTab] = useState<Tab>("approvals");

  const goToApprovals = useCallback(() => setTab("approvals"), []);
  usePushRegistration(goToApprovals);

  return (
    <View style={styles.root}>
      <View style={styles.body}>
        {tab === "feed" ? <FeedScreen /> : <ApprovalsScreen />}
      </View>

      <View style={styles.tabBar}>
        <TabButton label="승인함" active={tab === "approvals"} onPress={goToApprovals} />
        <TabButton label="라이브 피드" active={tab === "feed"} onPress={() => setTab("feed")} />
      </View>
    </View>
  );
}

function TabButton({
  label,
  active,
  onPress
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      style={[styles.tab, active && styles.tabActive]}
      onPress={onPress}
    >
      <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.appBg },
  body: { flex: 1 },
  tabBar: {
    flexDirection: "row",
    gap: spacing.md,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.md,
    paddingBottom: spacing.xxl,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface
  },
  tab: {
    flex: 1,
    minHeight: spacing.touchTarget,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceMuted
  },
  tabActive: { backgroundColor: colors.accent },
  tabLabel: { color: colors.textSubtle, fontSize: fontSize.body, fontWeight: fontWeight.heavy },
  tabLabelActive: { color: colors.textInverse }
});
