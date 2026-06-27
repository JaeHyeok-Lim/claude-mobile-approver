# bridge/

Node + TypeScript service. The trust boundary between Claude Code hooks and the mobile app.

Responsibilities:
- **Approval store** — `requestId → {status: pending|allow|deny}`; create (hook), resolve (app),
  poll (hook). **Default-deny on TTL expiry.**
- **Event feed** — recent reports/status events.
- **Push** — Expo push on new approval requests / reports.
- **Live channel** — SSE or WebSocket for the app's live feed.
- **Auth** — shared bearer token (min) on every request.

Scaffold with TypeScript. Keep secrets in `.env` (gitignored); commit `.env.example`.
Not yet implemented — see [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md).
