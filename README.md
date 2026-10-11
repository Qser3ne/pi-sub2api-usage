# pi-sub2api-usage

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that shows your
[sub2api](https://github.com/Wei-Shaw/sub2api) upstream account's subscription-quota
usage in the statusline, in the same spot where `@narumitw/pi-usage` shows provider
usage — and coexisting with it: providers that pi-usage handles keep their native
display, sub2api providers get theirs.

Statusline preview (rendered by `@narumitw/pi-statusline`):

```
📊 sub2api-claude 86% ↻ 4h12m 74% ↻ 3d13h
```

- `86% ↻ 4h12m` — 5-hour window REMAINING, resetting in 4h12m
- `74% ↻ 3d13h` — 7-day window REMAINING, resetting in 3d13h

(Percentages show remaining quota, matching pi-usage's codex-style default.)

## How it works

- Reads `~/.pi/agent/models.json` and reacts to providers marked with `"sub2api": true`.
- The provider's quota comes from the sub2api **admin account-usage endpoint**
  (`GET /api/v1/admin/accounts/{id}/usage`), i.e. the same numbers as the
  "查询额度" card in the admin panel's account list. This requires an admin account.
- Logs into the panel with your email/password to mint access tokens (cached at
  `~/.pi/agent/pi-sub2api-usage-cache.json`, mode 0600; re-login happens automatically
  when they expire or a usage call returns 401).
- Refreshes on session start, model switch, and turn start; while a marked provider
  stays selected it also re-queries every `refreshMs` (5 min by default, like
  pi-usage), with a 30s failure backoff and a 60s countdown re-render.
- By default queries `source=passive` (locally recorded data, no upstream round-trip);
  set `"usageSource": "active"` to query upstream on every refresh instead.
- Publishes under its own status key `sub2api-usage`, so it never fights pi-usage.

## Install

```bash
pi install /path/to/pi-sub2api-usage
```

## Configure

### 1. Mark providers in `~/.pi/agent/models.json`

```json
"sub2api-claude": {
  "baseUrl": "http://your-instance:8080",
  "api": "anthropic-messages",
  "sub2api": true,
  "models": [ ... ]
}
```

> The account must be a subscription (OAuth) account — API-key relay accounts have no
> quota windows and the usage endpoint returns an error for them.

### 2. Create `~/.pi/agent/pi-sub2api-usage.json`

```json
{
  "baseUrl": "http://your-instance:8080",
  "email": "admin@example.com",
  "password": "your-panel-password",
  "accounts": { "sub2api-claude": 3589 }
}
```

The number is the account id shown in the admin panel's account list. Then:

```bash
chmod 600 ~/.pi/agent/pi-sub2api-usage.json
```

All fields:

| Field | Default | Meaning |
|---|---|---|
| `baseUrl` | derived from the provider's `baseUrl` (trailing `/v1` stripped) | sub2api instance root |
| `email` / `password` | — | admin panel credentials for auto-login |
| `token` | — | manual access-token override; wins over auto-login, never refreshed |
| `route` | `/api/v1/admin/accounts/{id}/usage` | route template; `{id}` is replaced |
| `method` | `GET` | `GET` or `POST` |
| `usageSource` | `passive` | `passive` (cached) or `active` (upstream query) |
| `accounts` | `{}` | `providerId → account id` mapping |
| `refreshMs` | `300000` | usage cache TTL |

## Preconditions

- Panel account with admin role (the usage endpoint is admin-only).
- The instance must not require a login captcha (Turnstile / Tencent), and the
  account must not have TOTP 2FA enabled — auto-login cannot pass either. With
  captcha/2FA, use the manual `token` field instead (paste a fresh panel JWT).

## Command

`/sub2api-usage` — force-refreshes and prints the parsed usage payload for the
 current provider.

## Uninstall

```bash
pi remove pi-sub2api-usage
```
