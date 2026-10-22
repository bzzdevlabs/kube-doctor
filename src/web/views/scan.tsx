// Scan & settings: what was scanned, API health, RBAC coverage, preferences, muted problems.
import type { CoverageEntry } from '../../shared/types';
import { S, useStore, setPref, unmute, scan, type Density, type Theme } from '../app/store';
import { ago, dateTime, plural } from '../app/fmt';
import { Badge, Button, Disclosure, Dot, KV, Section, Segmented, Empty } from '../components/ui';
import { DataTable, type Column } from '../components/table';
import { PageHeader } from './common';

const COV_TONE = { ok: 'ok', partial: 'warn', forbidden: 'crit', unsupported: 'muted', error: 'crit' } as const;

export function Scan() {
  const s = useStore();
  const r = s.report!;
  const m = r.meta;
  const cov = r.coverage;
  const covBad = cov.filter((c) => c.status === 'forbidden' || c.status === 'error').length;
  const covPartial = cov.filter((c) => c.status === 'partial').length;
  const covColumns: Column<CoverageEntry>[] = [
    { key: 'st', label: 'Status', width: '110px', sort: (c) => c.status, render: (c) => <Badge tone={COV_TONE[c.status]}>{c.status}</Badge> },
    { key: 'res', label: 'Resource', sort: (c) => c.resource, render: (c) => <span class="mono small">{c.resource}</span> },
    { key: 'scope', label: 'Scope', width: '170px', render: (c) => <span class="small muted">{c.scope || '—'}</span> },
    { key: 'n', label: 'Objects', width: '90px', className: 'num', sort: (c) => -c.count, render: (c) => c.count },
    { key: 'ms', label: 'Time', width: '80px', className: 'num muted', sort: (c) => -c.ms, render: (c) => `${c.ms}ms` },
    { key: 'msg', label: 'Note', render: (c) => <span class="small" title={c.detail}>{c.message || ''}</span> },
  ];
  const muted = Object.entries(s.muted);
  const health = m.health;
  const failing = health?.checks.filter((c) => !c.ok) || [];
  const passing = health?.checks.filter((c) => c.ok) || [];
  return (
    <div class="page">
      <PageHeader icon="scan" title="Scan & settings" subtitle={`Last scan ${ago(m.scannedAt)}`}>
        <Button icon="refresh" onClick={() => void scan()} disabled={s.scanning}>Rescan</Button>
      </PageHeader>
      <div class="grid-2">
        <Section id="scan.meta" title="Cluster" icon="nodes">
          <KV items={[
            ['Context', <span class="mono">{m.context}</span>],
            ['Cluster', m.cluster && <span class="mono">{m.cluster}</span>],
            ['API server', m.server && <span class="mono">{m.server}</span>],
            ['User', m.user && <span class="mono">{m.user}</span>],
            ['Kubernetes', m.version],
            ['Scope', m.scannedNamespace ? <span>namespace <b>{m.scannedNamespace}</b> only (no cluster-wide list permission)</span> : 'all namespaces'],
            ['Scanned', `${dateTime(m.scannedAt)} in ${(m.durationMs / 1000).toFixed(1)}s`],
            ['Metrics', m.metricsAvailable ? <span class="ok-text">available (kubectl top)</span> : <span class="warn-text">unavailable{m.metricsError ? ` — ${m.metricsError}` : ''}</span>],
            ['Mode', s.demo ? <Badge tone="warn">DEMO — simulated cluster</Badge> : 'live cluster'],
          ]} />
        </Section>
        <Section id="scan.health" title="API server health" icon="zap" subtitle={health?.ok == null ? 'unknown' : health.ok ? 'all checks pass' : 'failing checks'}>
          {health?.checks.length ? (
            <>
              {failing.length > 0 && (
                <ul class="checks">
                  {failing.map((c) => <li key={c.name}><Dot tone="crit" /><span class="mono small">{c.name}</span><span class="small crit-text">{c.message}</span></li>)}
                </ul>
              )}
              <Disclosure summary={<span><Dot tone="ok" /> {plural(passing.length, 'check')} passing</span>}>
                <ul class="checks">{passing.map((c) => <li key={c.name}><Dot tone="ok" /><span class="mono small">{c.name}</span></li>)}</ul>
              </Disclosure>
            </>
          ) : <div class="muted">{health?.error ? `Not available: ${health.error.message}` : 'The /readyz endpoint was not readable with your permissions.'}</div>}
        </Section>
      </div>

      <Section id="scan.cov" title="Coverage" icon="list" count={cov.length} flush
        subtitle={covBad || covPartial ? `${covBad ? plural(covBad, 'resource') + ' not readable' : ''}${covBad && covPartial ? ' · ' : ''}${covPartial ? `${covPartial} partial` : ''}` : 'everything was readable'}>
        <div class="section-pad muted small">What Kube Doctor could read with your RBAC permissions. Problems on resources it could not read cannot be detected.</div>
        <DataTable id="coverage" columns={covColumns} rows={cov} rowKey={(c) => c.key} pageSize={100}
          rowClass={(c) => (c.status === 'forbidden' || c.status === 'error' ? 'sevrow-warning' : '')} defaultSort={{ key: 'st', dir: 'asc' }} />
      </Section>

      {r.internalErrors.length > 0 && (
        <Section id="scan.internal" title="Analyzer errors" icon="problems" count={r.internalErrors.length}>
          <div class="muted small">Some checks failed internally; their results may be missing. Please report these.</div>
          <ul class="plain-list">{r.internalErrors.map((e, i) => <li key={i}><b class="mono small">{e.where}</b>: {e.message}</li>)}</ul>
        </Section>
      )}

      <div class="grid-2">
        <Section id="scan.prefs" title="Preferences" icon="wrench">
          <div class="prefs">
            <div class="pref"><span>Theme</span>
              <Segmented<'auto' | 'light' | 'dark'> value={s.theme || 'auto'} onChange={(v) => setPref('theme', (v === 'auto' ? null : v) as Theme)}
                options={[{ value: 'auto', label: 'System' }, { value: 'light', label: 'Light', icon: 'sun' }, { value: 'dark', label: 'Dark', icon: 'moon' }]} />
            </div>
            <div class="pref"><span>Density</span>
              <Segmented<Density> value={s.density} onChange={(v) => setPref('density', v)} options={[{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }]} />
            </div>
            <div class="pref"><span>Auto-refresh</span>
              <Segmented<string> value={String(s.auto)} onChange={(v) => setPref('auto', Number(v))}
                options={[{ value: '0', label: 'Off' }, { value: '30', label: '30s' }, { value: '60', label: '1m' }, { value: '300', label: '5m' }]} />
            </div>
            <label class="pref pref-check">
              <span>Analyze container logs<span class="muted small"> — reads the previous logs of crashing containers to find the cause (slower on big clusters)</span></span>
              <input type="checkbox" checked={s.analyzeLogs} onChange={(e) => setPref('analyzeLogs', e.currentTarget.checked)} />
            </label>
          </div>
        </Section>
        <Section id="scan.muted" title="Muted problems" icon="eyeOff" count={muted.length}>
          {muted.length ? (
            <ul class="muted-list">
              {muted.sort((a, b) => b[1].at - a[1].at).map(([id, x]) => (
                <li key={id}>
                  <div><div>{x.title}</div><div class="muted small">{x.object} · muted {ago(x.at)}{S.idx?.byId.has(id) ? '' : ' · no longer present'}</div></div>
                  <Button size="sm" icon="eye" onClick={() => unmute(id)}>Unmute</Button>
                </li>
              ))}
            </ul>
          ) : <Empty icon="eye" title="Nothing muted">Mute a known problem from its card or the inspector to hide it from lists and counts. Mutes are stored per context in this browser.</Empty>}
        </Section>
      </div>

      <Section id="scan.ro" title="Read-only guarantee" icon="scan" defaultOpen={false}>
        <p>Kube Doctor only runs <code>kubectl get</code>, <code>logs</code>, <code>top</code>, <code>version</code> and <code>config view/get-contexts/current-context</code>, through an allowlist enforced by the server. It never changes your kubeconfig (the context is passed with <code>--context</code> on each call), never reads Secrets or ConfigMaps, and masks secret-looking environment values.</p>
        <p class="muted small">The web server listens on 127.0.0.1 only, accepts GET requests only and rejects requests addressed to other host names.</p>
      </Section>
    </div>
  );
}
