#!/usr/bin/env node
// Tebex Server API (Plugin API) fetcher — returns JSON to stdout.
// Auth: X-Tebex-Secret header carrying the Server Secret key.
// Base URL: https://plugin.tebex.io
// Credential: Tebex dashboard → Integrations → Server API → Secret Key
//
// Endpoints:
//   GET /information           — store metadata + auth probe
//   GET /payments?paged=1&page=N — transactions (paginated, ~100/page)
//   GET /listing               — package catalog
//
// Commands:
//   node fetch.js              — alias for info
//   node fetch.js info         — GET /information (auth probe)
//   node fetch.js payments     — GET /payments page 1
//   node fetch.js products     — GET /listing

import dotenv from 'dotenv';
import https from 'https';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../../../.env'), override: true });

const API_KEY = process.env.TEBEX_API_KEY?.trim();

if (!API_KEY) {
  console.error(JSON.stringify({
    error: 'TEBEX_API_KEY is not set.',
    hint:  'Add TEBEX_API_KEY=<your Server Secret> to .env — find it at Tebex dashboard → Integrations → Server API',
  }));
  process.exit(1);
}

const cmd = process.argv[2] ?? 'info';

const ROUTES = {
  info:     '/information',
  payments: '/payments?paged=1&page=1',
  products: '/listing',
};

if (!(cmd in ROUTES)) {
  console.error(JSON.stringify({
    error: `Unknown command "${cmd}". Valid commands: info, payments, products`,
  }));
  process.exit(1);
}

const options = {
  hostname: 'plugin.tebex.io',
  path:     ROUTES[cmd],
  method:   'GET',
  headers: {
    'X-Tebex-Secret': API_KEY,
    'Accept':         'application/json',
  },
};

const req = https.request(options, (res) => {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    let parsed;
    try { parsed = JSON.parse(body); } catch { parsed = body; }

    if (res.statusCode >= 200 && res.statusCode < 300) {
      process.stdout.write(JSON.stringify(parsed, null, 2) + '\n');
      process.exit(0);
    }

    const errMsg =
      parsed?.error_message ??
      parsed?.error ??
      parsed?.message ??
      (res.statusCode === 403 ? 'Auth rejected — verify the key is a Server Secret from Integrations → Server API.' : `HTTP ${res.statusCode}`);

    console.error(JSON.stringify({ error: errMsg, status: res.statusCode, body: parsed }));
    process.exit(1);
  });
});

req.on('error', (err) => {
  console.error(JSON.stringify({ error: 'Network error', detail: err.message }));
  process.exit(1);
});

req.end();
