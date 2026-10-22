// Server-internal types. Kubernetes objects are typed in ./k8s.ts; everything
// Kube Doctor produces is typed in ../shared/types.ts.
import type { ApiHealth, ContextInfo, CoverageEntry, Finding, NodeUsage, Severity } from '../shared/types.js';
import type { KindMap, ResourceKey } from './k8s.js';

export type { AnyObj, EventObj, KindMap, ResourceKey } from './k8s.js';

export interface PodMetric {
  namespace: string;
  pod: string;
  container: string;
  cpu: number | null;
  memory: number | null;
}

export interface ErrorInfo {
  kind: string;
  message: string;
  detail?: string;
}

export interface MetricsResult<T> {
  ok: boolean;
  items: T[];
  error?: ErrorInfo;
}

export type CollectedData = { [K in ResourceKey]?: KindMap[K][] };

export interface CollectedInfo extends ContextInfo {
  version: string | null;
  scannedNamespace: string | null;
}

export interface Collected {
  info: CollectedInfo;
  data: CollectedData;
  coverage: CoverageEntry[];
  health?: ApiHealth;
  metrics: { nodes?: MetricsResult<NodeUsage>; pods?: MetricsResult<PodMetric> };
  startedAt: number;
  durationMs: number;
}

export interface RunOptions {
  context?: string;
  timeout?: number;
  requestTimeout?: string | null;
}

export interface Kubectl {
  run(args: string[], opts?: RunOptions): Promise<string>;
  json<T>(args: string[], opts?: RunOptions): Promise<T>;
  bin: string;
  demo: boolean;
}

/** A finding while it is being built by the analyzers (before grouping and correlation). */
export type DraftFinding = Omit<Finding, 'id' | 'rootCause' | 'tags' | 'evidence' | 'fixes' | 'commands' | 'refs' | 'causedBy' | 'rootCauseOf' | 'instances' | 'severity'> & {
  id?: string;
  severity?: Severity;
  tags?: (string | undefined)[];
  rootCause: { summary: string; details?: string[]; confidence?: Finding['rootCause']['confidence']; derived?: boolean; fromLogs?: boolean };
  evidence?: (string | null | undefined | false)[];
  fixes?: string[];
  commands?: string[];
  refs?: string[];
  causedBy?: string[];
  rootCauseOf?: string[];
  instances?: Finding['instances'];
  groupKey?: string;
  wantsLogs?: boolean;
  sharedCause?: string;
};

/** Finding with the analyzer-only bookkeeping fields still attached. */
export type WorkFinding = Finding & { groupKey?: string; wantsLogs?: boolean; sharedCause?: string };

export interface FindingSink {
  findings: WorkFinding[];
  add(f: DraftFinding): void;
  internalError(e: unknown, where: string): void;
}
