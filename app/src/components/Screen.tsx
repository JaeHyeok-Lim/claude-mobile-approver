import React from "react";
import { SafeAreaView, ScrollView, StyleSheet, View } from "react-native";
import { colors, spacing } from "../theme";

// Screen — top-level page wrapper. Mirrors a reference app's SafeAreaView + ScrollView
// page pattern. `scroll` defaults true (live feed / inbox are lists); set false
// for fixed layouts.
export function Screen({
  children,
  scroll = true
}: {
  children: React.ReactNode;
  scroll?: boolean;
}) {
  return (
    <SafeAreaView style={styles.safeArea}>
      {scroll ? (
        <ScrollView contentContainerStyle={styles.page}>{children}</ScrollView>
      ) : (
        <View style={styles.page}>{children}</View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.appBg },
  page: { padding: spacing.xxl, paddingBottom: 40, gap: spacing.xl }
});
