// Deploys `frontend/` to Vercel from local files.
//
//   npm run deploy:web
//
// Why not push to deploy: the current Vercel account cannot be linked to the
// GitHub repository from the API, so the frontend ships as an API deployment.
// The Render backend auto-deploys from `main`; this is the matching button for
// the static site.
//
// Reads the shared deploy token from the .env one directory above the project
// root, never from a repo. Never commit that file, and never print the token.
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERCEL, VERCEL_TEAM_ID } from '../../env.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'frontend');
const PROJECT = process.env.VERCEL_PROJECT ?? 'boss-near';
const TOKEN = process.env.VERCEL_TOKEN ?? VERCEL;
if (!TOKEN) {
  console.error('no Vercel token (env VERCEL_TOKEN, or the .env one directory above the project root)');
  process.exit(1);
}

const query = VERCEL_TEAM_ID ? `?teamId=${encodeURIComponent(VERCEL_TEAM_ID)}` : '';
const headers = { authorization: `Bearer ${TOKEN}` };
const walk = (root) => {
  const out = [];
  const go = (sub) => {
    for (const entry of readdirSync(join(root, sub), { withFileTypes: true })) {
      if (entry.name === 'package.json') continue;
      const rel = sub ? `${sub}/${entry.name}` : entry.name;
      if (entry.isDirectory()) go(rel);
      else if (/\.(html|js|css|json|svg|png|ico|txt|webmanifest)$/i.test(entry.name)) out.push(rel);
    }
  };
  go('');
  return out;
};
const files = walk(dir);

const manifest = [];
for (const file of files) {
  const buf = readFileSync(join(dir, file));
  const sha = createHash('sha1').update(buf).digest('hex');
  const up = await fetch(`https://api.vercel.com/v2/files${query}`, {
    method: 'POST',
    headers: { ...headers, 'x-vercel-digest': sha, 'content-type': 'application/octet-stream' },
    body: buf,
  });
  if (!up.ok && up.status !== 409) {
    console.error(`upload failed: ${file} (${up.status})`);
    process.exit(1);
  }
  manifest.push({ file, sha, size: buf.length });
}

const res = await fetch(`https://api.vercel.com/v13/deployments${query}`, {
  method: 'POST',
  headers: { ...headers, 'content-type': 'application/json' },
  body: JSON.stringify({
    name: PROJECT,
    project: PROJECT,
    target: 'production',
    files: manifest,
    projectSettings: {
      framework: null,
      buildCommand: null,
      outputDirectory: null,
      installCommand: null,
      devCommand: null,
      rootDirectory: null,
    },
  }),
});
const deployed = await res.json();
if (!res.ok) {
  console.error(`deployment rejected (${res.status})`);
  console.error(JSON.stringify(deployed).slice(0, 400));
  process.exit(1);
}
const id = deployed.id;
process.stdout.write(`deployed ${id}`);

for (let i = 0; i < 60; i++) {
  const state = await (
    await fetch(`https://api.vercel.com/v13/deployments/${id}${query}`, { headers })
  ).json();
  if (state.readyState === 'READY' || state.readyState === 'ERROR') {
    console.log(`\nstate: ${state.readyState}`);
    console.log(`url:   ${state.url}`);
    console.log(`alias: ${JSON.stringify(state.alias ?? [])}`);
    process.exit(state.readyState === 'READY' ? 0 : 1);
  }
  await new Promise((r) => setTimeout(r, 2500));
  process.stdout.write('.');
}
console.log('\ntimed out waiting for READY');
process.exit(1);
