import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ENV_EXAMPLE = path.join(ROOT, '.env.example');
const ENV = path.join(ROOT, '.env');

function ask(rl: readline.Interface, q: string): Promise<string> {
  return new Promise(resolve => rl.question(q, a => resolve(a)));
}

interface EnvBlock {
  comments: string[];
  key: string;
  value: string;
}

function parseEnvExample(text: string): EnvBlock[] {
  const out: EnvBlock[] = [];
  let comments: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed === '') {
      comments.push(line);
      continue;
    }
    const idx = line.indexOf('=');
    if (idx === -1) { comments.push(line); continue; }
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1);
    out.push({ comments, key, value });
    comments = [];
  }
  return out;
}

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log('\n🐝 DHS-Hive setup\n');

  if (fs.existsSync(ENV)) {
    const ans = (await ask(rl, '.env already exists. Overwrite? (y/N) ')).trim().toLowerCase();
    if (ans !== 'y' && ans !== 'yes') {
      console.log('Keeping existing .env. Run `npm run migrate` if you need to apply schema changes.');
      rl.close();
      return;
    }
  }

  const example = fs.readFileSync(ENV_EXAMPLE, 'utf8');
  const blocks = parseEnvExample(example);

  console.log('\nFor each setting, press Enter to keep the default. Type a value to override.\n');

  const out: string[] = [];
  for (const b of blocks) {
    out.push(...b.comments);
    const def = b.value;
    const ans = (await ask(rl, `${b.key} [${def || '(empty)'}]: `)).trim();
    out.push(`${b.key}=${ans !== '' ? ans : def}`);
  }
  fs.writeFileSync(ENV, out.join('\n'), 'utf8');
  console.log(`\n.env written.`);

  const runMigrate = (await ask(rl, 'Apply database migrations now? (Y/n) ')).trim().toLowerCase();
  rl.close();
  if (runMigrate !== 'n' && runMigrate !== 'no') {
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync(process.execPath, [path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(ROOT, 'scripts', 'migrate.ts')], { stdio: 'inherit' });
    if (r.status !== 0) {
      console.warn('Migration failed. Run `npm run migrate` manually.');
    }
  }

  console.log('\nNext: `npm start` to launch the dashboard.');
}

main().catch(err => { console.error(err); process.exit(1); });
