# deploy/ — authenticated tunnel for the bridge

The bridge binds to **loopback (`127.0.0.1:4318`)** on purpose: it is the trust boundary
and must **never** be an open public endpoint (`docs/ARCHITECTURE.md` § Security model).
To reach it from your phone, we put an **authenticated tunnel** in front of loopback —
no inbound ports opened, no public anonymous URL for anything persistent.

```
phone ──https──► tunnel edge (authenticated) ──► 127.0.0.1:4318 (bridge, bearer-auth)
```

Two gates, defense in depth:
1. **Edge auth** — Cloudflare Access policy / ngrok OAuth|Basic-Auth — keeps the world from
   even reaching the bridge.
2. **Bridge token** — `BRIDGE_TOKEN` bearer-checked on *every* route (incl. `/v1/healthz`).

## Quick start (scripts in `scripts/`)

```sh
# 0. one-time: bridge token + deploy config
cp bridge/.env.example bridge/.env       # set a strong BRIDGE_TOKEN
cp deploy/.env.example deploy/.env       # choose TUNNEL_PROVIDER / TUNNEL_MODE

# 1. bring the whole stack up (bridge -> health gate -> tunnel)
node scripts/up.mjs
#   …or the wrappers:  scripts/up.ps1   |   scripts/up.sh
```

`up.mjs` starts the bridge, **waits for `/v1/healthz` to go green before it ever opens a
tunnel**, then prints the public URL and the exact line to paste into `app/.env`:

```
BRIDGE_PUBLIC_URL=https://something.trycloudflare.com
EXPO_PUBLIC_BRIDGE_BASE_URL=https://something.trycloudflare.com/v1
```

Set `app/.env`:
```
EXPO_PUBLIC_BRIDGE_BASE_URL=<the URL above>
EXPO_PUBLIC_BRIDGE_TOKEN=<same value as bridge BRIDGE_TOKEN>
```

Individual scripts:
- `node scripts/run-bridge.mjs` — bridge only, with token preflight + health gate.
- `node scripts/tunnel.mjs [--provider cloudflare|ngrok] [--mode quick|named]` — tunnel only.
- `node scripts/health.mjs` — one-shot authenticated `/v1/healthz` probe (exit 0 = up).

## Provider A — Cloudflare (recommended)

Install: `winget install --id Cloudflare.cloudflared`

### Quick mode (`TUNNEL_MODE=quick`) — testing only
`cloudflared --url` mints an ephemeral `*.trycloudflare.com` URL. The edge is
**unauthenticated** — only the bridge token protects it. Fine for a few minutes of local
testing; `tunnel.mjs` prints a loud warning. Do not leave it running unattended.

### Named mode (`TUNNEL_MODE=named`) — persistent, authenticated edge
A stable hostname behind a Cloudflare Access policy, so only your identity reaches it.

```sh
cloudflared tunnel login
cloudflared tunnel create agent-mobile-bridge          # prints <TUNNEL_ID> + creds json path
cloudflared tunnel route dns agent-mobile-bridge bridge.example.com
cp deploy/cloudflared/config.example.yml deploy/cloudflared/config.yml
#   edit config.yml: set tunnel id, credentials-file path, hostname
```
Then in **Cloudflare Zero Trust → Access → Applications**, add `bridge.example.com` with a
policy that allows only your email. That Access policy is what makes the hostname non-public.

```sh
# deploy/.env: TUNNEL_PROVIDER=cloudflare  TUNNEL_MODE=named  CF_TUNNEL_NAME=agent-mobile-bridge
node scripts/up.mjs --mode named
```

> Note for native app clients: a browser-login Access policy works for opening the URL, but the
> Expo app's `fetch` can't do an interactive OAuth dance. For the app, use a **service token**
> (Access → Service Auth) and send `CF-Access-Client-Id`/`CF-Access-Client-Secret` headers, or
> use an Access policy that the app can satisfy. Wiring those headers is an `app/` concern —
> flagged below as an integration point.

## Provider B — ngrok

Install: `winget install --id Ngrok.Ngrok` then `ngrok config add-authtoken <token>`.

```sh
cp deploy/ngrok.example.yml deploy/ngrok.yml      # edit: pin OAuth or Basic-Auth, set upstream port
# deploy/.env: TUNNEL_PROVIDER=ngrok  NGROK_ENDPOINT=bridge
node scripts/up.mjs --provider ngrok
```
`deploy/ngrok.yml` pins **OAuth / Basic-Auth / IP allow-list** on the endpoint, so the tunnel
is authenticated at the edge — not an open door.

## Operational notes / risks

- **Token = app secret.** `EXPO_PUBLIC_*` is inlined into the JS bundle, so the bridge token
  ships on the device. That's acceptable ONLY because the tunnel edge is also authenticated.
  Rotate `BRIDGE_TOKEN` (and the app value) if a device is lost.
- **Quick-mode caveat.** `*.trycloudflare.com` is anonymous; treat it as token-only protection
  and short-lived. Never use it as the persistent prod URL.
- **No inbound ports.** Both providers dial OUT to their edge; you never open a firewall port,
  so there's no listening public socket to scan/attack.
- **Reversible.** Stopping the script (Ctrl-C) tears the tunnel down; the public URL dies with
  it. No infra is left running. Named-tunnel DNS records persist and can be deleted with
  `cloudflared tunnel route dns ... ` / the dashboard.
- **Cost.** cloudflared + a free Cloudflare account: $0 for this use. ngrok free tier works but
  random URLs; reserved domains/OAuth may need a paid plan.

## Files
- `.env.example` → copy to `deploy/.env` (provider/mode selection; gitignored).
- `ngrok.example.yml` → copy to `deploy/ngrok.yml` (edge auth; gitignored).
- `cloudflared/config.example.yml` → copy to `deploy/cloudflared/config.yml` (named tunnel; gitignored).
