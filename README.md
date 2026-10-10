# pi-sub2api-usage

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that shows your
[sub2api](https://github.com/Wei-Shaw/sub2api) platform-quota usage in the statusline,
in the same spot where `@narumitw/pi-usage` shows provider usage — and coexisting with
it: providers that pi-usage handles keep their native display, sub2api providers get
theirs.

Statusline preview (rendered by `@narumitw/pi-statusline`):

```
📊 sub2api-gpt 62% ↻ 4h12m · wk 31% · mo 12%
```

- `62%` — daily window used (`$6.2/$10`); falls back to `$6.2` when no limit is set
- `↻ 4h12m` — countdown to the daily window reset
- `wk 31%` / `mo 12%` — weekly and monthly window usage

## How it works

- Reads `~/.pi/agent/models.json` and reacts to providers marked with `"sub2api": true`.
- Derives the sub2api platform from the provider's `api` field
  (`anthropic-messages` → `anthropic`, `openai*` → `openai`), overridable via `platformMap`.
- Logs into the panel with your email/password to mint access tokens (cached at
  `~/.pi/agent/pi-sub2api-usage-cache.json`, mode 0600; re-login happens automatically
  when they expire or a quota call returns 401).
- Polls `GET /api/v1/user/platform-quotas` on session start, model switch, and turn
  start, with a 5-minute cache, 30s failure backoff, and 60s countdown re-render —
  mirroring pi-usage's refresh cadence.
- Publishes under its own status key `sub2api-usage`, so it never fights pi-usage.

## Install

```bash
pi install /path/to/pi-sub2api-usage
```

## Configure

### 1. Mark providers in `~/.pi/agent/models.json`

```json
"sub2api-gpt": {
  "baseUrl": "http://your-instance:8080/v1",
  "api": "openai-responses",
  "sub2api": true,
  "models": [ ... ]
}
```

### 2. Create `~/.pi/agent/pi-sub2api-usage.json`

```json
{
  "baseUrl": "http://your-instance:8080",
  "email": "you@example.com",
  "password": "your-panel-password"
}
```

Then:

```bash
chmod 600 ~/.pi/agent/pi-sub2api-usage.json
```

All fields:

| Field | Default | Meaning |
|---|---|---|
| `baseUrl` | derived from the provider's `baseUrl` (trailing `/v1` stripped) | sub2api instance root |
| `email` / `password` | — | panel credentials for auto-login |
| `token` | — | manual access-token override; wins over auto-login, never refreshed |
| `route` | `/api/v1/user/platform-quotas` | quota endpoint path |
| `method` | `GET` | `GET` or `POST` |
| `platformMap` | `{}` | explicit `providerId → platform` overrides |
| `refreshMs` | `300000` | quota cache TTL |

## Preconditions

- The instance must not require a login captcha (Turnstile / Tencent), and the
  account must not have TOTP 2FA enabled — auto-login cannot pass either. With
  captcha/2FA, use the manual `token` field instead (paste a fresh panel JWT).
- If the instance runs in backend mode, only admin accounts can log in.

## Command

`/sub2api-usage` — force-refreshes and prints the raw quota payload for the
current provider.

## Uninstall

```bash
pi remove pi-sub2api-usage
```
