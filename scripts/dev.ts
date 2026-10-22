// Development mode: API server with reload on change (port 7420) + Vite with hot reload (port 5173).
// Extra arguments go to the server, e.g. `npm run dev -- --demo`.
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = (...p: string[]) => path.join(root, 'node_modules', ...p);

const children: ChildProcess[] = [
  spawn(process.execPath, [bin('tsx', 'dist', 'cli.mjs'), 'watch', '--clear-screen=false', path.join(root, 'src/server/server.ts'), '--port', '7420', ...process.argv.slice(2)], { cwd: root, stdio: 'inherit' }),
  spawn(process.execPath, [bin('vite', 'bin', 'vite.js'), '--config', path.join(root, 'src/web/vite.config.ts')], { cwd: root, stdio: 'inherit' }),
];

console.log('\n  UI with hot reload: http://localhost:5173  (API on http://127.0.0.1:7420)\n');

const stop = () => {
  for (const c of children) c.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const c of children) c.on('exit', (code) => { if (code) stop(); });
