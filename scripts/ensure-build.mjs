// Runs before `npm start`: builds dist/ when it is missing or older than the sources.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputs = ['dist/server/server.js', 'dist/web/index.html'].map((f) => path.join(root, f));

function newest(dir) {
  let max = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    max = Math.max(max, e.isDirectory() ? newest(p) : statSync(p).mtimeMs);
  }
  return max;
}

const missing = outputs.some((f) => !existsSync(f));
// Published packages ship dist/ without src/: nothing to compare against.
const stale = !missing && existsSync(path.join(root, 'src')) && newest(path.join(root, 'src')) > Math.min(...outputs.map((f) => statSync(f).mtimeMs));

if (missing || stale) {
  if (!existsSync(path.join(root, 'node_modules', 'typescript'))) {
    console.error('Kube Doctor is not built and the build tools are missing: run `npm install` first.');
    process.exit(1);
  }
  console.log(missing ? 'Building Kube Doctor (first run)…' : 'Sources changed, rebuilding…');
  const r = spawnSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
