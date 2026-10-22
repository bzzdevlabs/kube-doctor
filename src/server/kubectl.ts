// Read-only kubectl wrapper.
//
// Every call to the cluster goes through `run()`, which refuses any kubectl
// sub-command that is not on the allowlist below. All allowed commands are
// reads: nothing in this app can create, patch, delete, exec, port-forward or
// change your kubeconfig (we never call `config use-context`; a context chosen
// in the UI is only passed as `--context=<name>`).
import { execFile } from 'node:child_process';
import type { Kubectl, RunOptions } from './types.js';

export type KubectlErrorKind = 'error' | 'refused' | 'auth' | 'unreachable' | 'nocontext' | 'forbidden' | 'unsupported' | 'notfound' | 'notready' | 'nokubectl';

const ALLOWED: Record<string, true | Set<string>> = {
  get: true,
  logs: true,
  top: true,
  version: true,
  config: new Set(['current-context', 'get-contexts', 'view']),
};

// Flags that could turn a read into something else, or point kubectl somewhere unexpected.
const FORBIDDEN_FLAGS = /^--?(f|w|filename|kubeconfig|server|token|as|as-group|as-uid|raw-write|edit|overwrite|follow|watch)(=|$)/;

export class KubectlError extends Error {
  kind: KubectlErrorKind;
  stderr: string;
  args: string[];

  constructor(message: string, { kind = 'error', stderr = '', args = [] }: { kind?: KubectlErrorKind; stderr?: string; args?: string[] } = {}) {
    super(message);
    this.kind = kind;
    this.stderr = stderr;
    this.args = args;
  }
}

export function assertReadOnly(args: string[]): void {
  const verb = args[0];
  const rule = ALLOWED[verb ?? ''];
  if (!rule) throw new KubectlError(`Refusing non read-only kubectl verb "${verb}"`, { kind: 'refused', args });
  if (rule instanceof Set && !rule.has(args[1] ?? '')) {
    throw new KubectlError(`Refusing kubectl ${verb} ${args[1]}`, { kind: 'refused', args });
  }
  for (const a of args.slice(1)) {
    if (FORBIDDEN_FLAGS.test(a)) throw new KubectlError(`Refusing kubectl flag "${a}"`, { kind: 'refused', args });
  }
}

export function classifyError(text: string): KubectlErrorKind {
  const s = text || '';
  if (/executable file not found|exec plugin|getting credentials|failed to get token|token expired|refresh token|interactive login|az login|aws sso login|gcloud auth/i.test(s)) return 'auth';
  if (/Unauthorized|You must be logged in|provide credentials/i.test(s)) return 'auth';
  if (/Unable to connect to the server|The connection to the server .* was refused|did you specify the right host|connection refused|no such host|i\/o timeout|TLS handshake timeout|context deadline exceeded|dial tcp|EOF$|Client\.Timeout|connection reset/i.test(s)) return 'unreachable';
  if (/current-context is not set|context .* does not exist|no context exists|context was not found/i.test(s)) return 'nocontext';
  if (/forbidden/i.test(s)) return 'forbidden';
  if (/the server doesn't have a resource type|the server could not find the requested resource|no matches for kind|Metrics API not available|metrics not available yet|unknown command|unknown flag/i.test(s)) return 'unsupported';
  if (/NotFound|not found|previous terminated container/i.test(s)) return 'notfound';
  if (/is waiting to start|ContainerCreating|PodInitializing|BadRequest/i.test(s)) return 'notready';
  return 'error';
}

function firstLine(text: string): string {
  const lines = String(text).split('\n').map((l) => l.trim()).filter(Boolean);
  // Prefer the actual "error:" line kubectl prints over client-side warnings.
  return lines.find((l) => /^(error|Error from server)/.test(l)) || lines[0] || 'kubectl failed';
}

export function createKubectl({ bin = process.env.KUBECTL || 'kubectl', timeoutMs = 90_000 }: { bin?: string; timeoutMs?: number } = {}): Kubectl {
  function run(args: string[], { context, timeout = timeoutMs, requestTimeout = '30s' }: RunOptions = {}): Promise<string> {
    assertReadOnly(args);
    const full = [...args];
    if (context) full.push(`--context=${context}`);
    if (args[0] !== 'config' && requestTimeout) full.push(`--request-timeout=${requestTimeout}`);
    return new Promise<string>((resolve, reject) => {
      execFile(
        bin,
        full,
        { maxBuffer: 1024 * 1024 * 1024, timeout, windowsHide: true, env: process.env },
        (err, stdout, stderr) => {
          if (!err) return resolve(stdout);
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            return reject(new KubectlError(`kubectl was not found ("${bin}"). Install kubectl or set KUBECTL=/path/to/kubectl.`, { kind: 'nokubectl', args: full }));
          }
          if (err.killed) {
            return reject(new KubectlError(`kubectl timed out after ${Math.round(timeout / 1000)}s`, { kind: 'unreachable', args: full }));
          }
          const msg = String(stderr || err.message || '').trim();
          reject(new KubectlError(firstLine(msg), { kind: classifyError(msg), stderr: msg, args: full }));
        },
      );
    });
  }

  async function json<T>(args: string[], opts?: RunOptions): Promise<T> {
    const out = await run([...args, '-o', 'json'], opts);
    try {
      return JSON.parse(out) as T;
    } catch {
      throw new KubectlError(`kubectl returned invalid JSON for: ${args.join(' ')}`, { kind: 'error', args });
    }
  }

  return { run, json: json as Kubectl['json'], bin, demo: false };
}
