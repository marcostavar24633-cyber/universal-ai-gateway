#!/usr/bin/env node
// Creates a token for a new project and stores it as the Worker secret
// PROJECT_KEY_<NAME>, without touching other projects' tokens.
// Usage: npm run add-project -- <project-name>
// The token is copied to the clipboard and never printed unless --print is given.
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const WORKER_NAME = 'universal-ai-gateway';
const args = process.argv.slice(2);
const print = args.includes('--print');
const name = args.find(arg => !arg.startsWith('--'));

if (!name || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) {
  console.error('Usage: npm run add-project -- <project-name>   (lowercase letters, digits and dashes, up to 40 chars)');
  process.exit(1);
}

const secretName = `PROJECT_KEY_${name.toUpperCase().replace(/-/g, '_')}`;
const token = randomBytes(32).toString('hex');
const windows = process.platform === 'win32';

console.log(`Creating secret ${secretName} for project "${name}" on Worker ${WORKER_NAME}...`);
const put = spawnSync(windows ? 'npx.cmd' : 'npx', ['wrangler', 'secret', 'put', secretName, '--name', WORKER_NAME], {
  input: token, stdio: ['pipe', 'inherit', 'inherit'], shell: windows,
});
if (put.status !== 0) {
  console.error('wrangler secret put failed; nothing was changed. Run `npx wrangler login` and try again.');
  process.exit(put.status || 1);
}

const clipboard = windows ? ['clip', []] : process.platform === 'darwin' ? ['pbcopy', []] : ['xclip', ['-selection', 'clipboard']];
const copied = spawnSync(clipboard[0], clipboard[1], { input: token, shell: windows }).status === 0;

if (copied) console.log(`Done. The token for "${name}" is in your clipboard — store it in a password manager now.`);
if (print || !copied) console.log(`Token for "${name}": ${token}`);
