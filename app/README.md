# app/

Expo (React Native) mobile app.

- Register for push (Expo push token → bridge).
- **Live feed** — current Claude Code / subagent activity from the bridge event feed.
- **Approvals** — pending tool calls with **Approve / Deny**; tapping resolves the request in the
  bridge and unblocks the waiting `PreToolUse` hook.

Config via `EXPO_PUBLIC_*` env (see `.env.example`): the bridge base URL and the shared token.
Run with `npx expo start` (a real device / Expo Go is needed for push). Note `EXPO_PUBLIC_*`
values are inlined into the JS bundle — acceptable only behind the authenticated tunnel / private
network the bridge lives on.
