# Tebex

Fetches data from the **Tebex Server API** (Plugin API) using a single
`X-Tebex-Secret` header. The credential is the **Server Secret** from
Tebex dashboard → Integrations → Server API.

Base URL: `https://plugin.tebex.io`

## Prerequisites

One value must be set in the repo-root `.env`:

| Key | Where to find it |
|---|---|
| `TEBEX_API_KEY` | Tebex dashboard → Integrations → Server API → Secret Key |

This is NOT the Checkout API private key and NOT the Headless/Creator API key.
It is the per-store Server Secret used by FiveM game servers and store owners
to access transactional data.

## Fetcher

**Script:** `skills/tebex/scripts/fetch.js`

Run from the repo root:

```bash
node skills/tebex/scripts/fetch.js [command]
```

Returns JSON to stdout. Exits 1 with a JSON error on bad config or non-2xx response.

## Supported commands

| Command | Endpoint | What it returns |
|---|---|---|
| `info` (default) | `GET /information` | Store metadata, currency, account name — doubles as auth probe |
| `payments` | `GET /payments?paged=1&page=1` | First page of transactions (~100 rows), paginated envelope with meta.last_page |
| `products` | `GET /listing` | Package catalog; handles bare array or `{ categories: [{ packages }] }` shape |

## How ops uses this

```bash
# Verify the Server Secret is working
node skills/tebex/scripts/fetch.js info

# Pull first page of payments
node skills/tebex/scripts/fetch.js payments

# List packages/products
node skills/tebex/scripts/fetch.js products
```

## Missing-key behavior

If `TEBEX_API_KEY` is absent, the script exits 1 and prints a JSON error
pointing to the Server API page. Ops reports this message verbatim.

## Response shape notes

- `/information` returns `{ account: { name, currency: { iso_4217 }, ... }, ... }`
- `/payments` with `paged=1` wraps as `{ data: [...], meta: { last_page, ... } }`; without it returns a bare array
- `/listing` returns `{ categories: [{ packages: [...] }] }` or a flat array depending on store config

A 403 from any endpoint means the key is not a valid Server Secret. Verify it
at Tebex dashboard → Integrations → Server API and paste the exact value shown.
