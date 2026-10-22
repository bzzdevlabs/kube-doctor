// Entry point: application layout and view routing.
import { render } from 'preact';
import { useStore, scan, setContext, currentTarget, init, type ViewId } from './app/store';
import { ApiError } from './app/api';
import { Icon } from './app/icons';
import { Button, Spinner } from './components/ui';
import { Topbar, NavRail, FiltersPanel, Help, Toasts, installHotkeys } from './components/shell';
import { Palette } from './components/palette';
import { Inspector } from './inspector';
import { Overview } from './views/overview';
import { Incidents } from './views/incidents';
import { Problems } from './views/problems';
import { Workloads } from './views/workloads';
import { Pods } from './views/pods';
import { Nodes } from './views/nodes';
import { Events } from './views/events';
import { Namespaces } from './views/namespaces';
import { Scan } from './views/scan';
import './styles/app.css';

const PAGES: Record<ViewId, () => preact.JSX.Element> = {
  overview: Overview, incidents: Incidents, problems: Problems, workloads: Workloads, pods: Pods,
  nodes: Nodes, events: Events, namespaces: Namespaces, scan: Scan,
};

function ErrorDetails({ error }: { error: Error }) {
  const e = error instanceof ApiError ? error : null;
  return (
    <>
      <p class="error-msg">{error.message}</p>
      {e?.hint && <p class="error-hint"><Icon name="info" size={14} /> {e.hint}</p>}
      {e?.detail && <details class="error-detail"><summary>kubectl output</summary><pre class="code">{e.detail}</pre></details>}
    </>
  );
}

function FullError() {
  const s = useStore();
  return (
    <div class="state-page">
      <div class="state-card">
        <div class="state-icon tone-crit"><Icon name="problems" size={26} /></div>
        <h2>Could not scan {s.context ? <span class="mono">{s.context}</span> : 'the cluster'}</h2>
        {s.error && <ErrorDetails error={s.error} />}
        <div class="state-actions">
          <Button icon="refresh" variant="primary" onClick={() => void scan()} disabled={s.scanning}>{s.scanning ? 'Retrying…' : 'Retry'}</Button>
          {s.contexts.length > 1 && (
            <select class="select-plain" value={s.context || ''} onChange={(e) => setContext(e.currentTarget.value)} aria-label="Switch context">
              {s.contexts.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          )}
        </div>
      </div>
    </div>
  );
}

function Loading() {
  const s = useStore();
  return (
    <div class="state-page">
      <div class="state-card">
        <Spinner size={28} />
        <h2>{s.context ? <>Scanning <span class="mono">{s.context}</span></> : 'Reading your kubeconfig'}</h2>
        <p class="muted">Listing pods, workloads, nodes, events, services, storage and webhooks (read-only), analyzing them and reading the logs of crashing containers.</p>
      </div>
    </div>
  );
}

function NoContext() {
  return (
    <div class="state-page">
      <div class="state-card">
        <div class="state-icon"><Icon name="nodes" size={26} /></div>
        <h2>No Kubernetes context found</h2>
        <p class="muted">Kube Doctor reads the contexts of your kubeconfig (<code>$KUBECONFIG</code> or <code>~/.kube/config</code>). Configure access to a cluster, then reload. Try <code>npm run demo</code> to explore with a simulated cluster.</p>
      </div>
    </div>
  );
}

function Main() {
  const s = useStore();
  if (!s.report) {
    if (s.error && !s.scanning) return <FullError />;
    if (s.contextsLoaded && !s.contexts.length && !s.error) return <NoContext />;
    return <Loading />;
  }
  const Page = PAGES[s.view];
  return (
    <>
      {s.error && (
        <div class="stale-banner">
          <Icon name="problems" size={15} />
          <span><b>The last refresh failed</b> — showing the scan from {new Date(s.report.meta.scannedAt).toLocaleTimeString()}. {s.error.message}</span>
          <Button size="sm" icon="refresh" onClick={() => void scan()}>Retry</Button>
        </div>
      )}
      <Page />
    </>
  );
}

function App() {
  const s = useStore();
  const inspecting = !!currentTarget();
  return (
    <div class={`app${s.navCollapsed ? ' nav-collapsed' : ''}${s.scanning ? ' is-scanning' : ''}`}>
      <Topbar />
      <div class="app-body">
        <NavRail />
        {s.filt.open && <FiltersPanel />}
        <main class="main-scroll" id="main">
          <Main />
        </main>
        {inspecting && <Inspector />}
      </div>
      <Palette />
      <Help />
      <Toasts />
    </div>
  );
}

installHotkeys();
render(<App />, document.getElementById('app')!);
void init();
