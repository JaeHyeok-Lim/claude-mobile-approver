import React from "react";
import { StyleSheet, Text, View } from "react-native";
import {
  ConnectionBanner,
  EventRow,
  Screen,
  StateView
} from "../components";
import { colors, fontSize, fontWeight, spacing } from "../theme";
import { useFeed } from "../hooks/useFeed";

// FeedScreen — the live feed tab: the mobile twin of the localhost:4317
// dashboard. Read-only stream of agent activity (events from notify.mjs).
export function FeedScreen() {
  const { events, loaded, connection, errorMessage } = useFeed();

  return (
    <Screen>
      <View style={styles.header}>
        <Text style={styles.brand}>Agent Bridge</Text>
        <Text style={styles.title}>라이브 피드</Text>
      </View>

      <ConnectionBanner state={connection} />

      {!loaded ? (
        <StateView kind="loading" title="피드를 불러오는 중…" />
      ) : events.length === 0 ? (
        <StateView
          kind={connection === "offline" ? "error" : "empty"}
          title={connection === "offline" ? "브릿지에 연결할 수 없습니다" : "아직 활동이 없습니다"}
          detail={connection === "offline" ? errorMessage : "에이전트가 작업을 시작하면 여기에 표시됩니다."}
        />
      ) : (
        events.map((event) => <EventRow key={event.id} event={event} />)
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { paddingTop: spacing.md, paddingBottom: spacing.xs, gap: spacing.sm },
  brand: { color: colors.accent, fontSize: fontSize.label, fontWeight: fontWeight.bold },
  title: { color: colors.text, fontSize: fontSize.title, fontWeight: fontWeight.heavy }
});
