// API contract between the Kube Doctor server and the web UI.

export type Severity = 'critical' | 'warning' | 'info';
export type Confidence = 'high' | 'medium' | 'low';

export interface ObjRef {
  kind: string;
  namespace: string;
  name: string;
}

export interface RootCause {
  summary: string;
  details: string[];
  confidence: Confidence;
  /** The finding's own explanation is generic; the real cause is upstream (see `inherited`). */
  derived?: boolean;
  fromLogs?: boolean;
  inherited?: { id: string; title: string; summary: string; object: ObjRef };
}

export interface Instance {
  pod: string;
  namespace: string;
  node: string | null;
  restarts: number;
  age: number | null;
  phase?: string;
  since?: number | null;
}

export interface Dependency {
  host: string;
  port: number | null;
  count: number;
  sample: string;
}

export interface ResolvedDependency {
  kind: 'Service' | 'Pod' | 'Localhost';
  namespace?: string;
  name?: string;
  how: string;
  missing?: boolean;
  note?: string;
}

export interface LogMatch {
  id: string;
  title: string;
  explain: string;
  line?: string;
  count: number;
}

export type LogInsight =
  | {
      source: 'previous' | 'current';
      empty: boolean;
      lastException: string | null;
      matches: LogMatch[];
      errorLines: string[];
      dependencies: (Dependency & { resolved: ResolvedDependency | null })[];
      error?: undefined;
    }
  | { error: string };

export interface Finding {
  id: string;
  category: string;
  severity: Severity;
  tags: string[];
  object: ObjRef;
  owner?: ObjRef | null;
  node?: string | null;
  container?: string;
  title: string;
  message?: string;
  rootCause: RootCause;
  evidence: string[];
  fixes: string[];
  commands: string[];
  refs: string[];
  causedBy: string[];
  rootCauseOf: string[];
  instances: Instance[];
  aliases?: string[];
  deep?: boolean;
  lastSeen?: number | null;
  since?: number | null;
  logInsight?: LogInsight;
  meta?: Record<string, unknown>;
}

export interface Incident {
  id: string;
  rootId: string;
  severity: Severity;
  impacted: string[];
  pods: number;
  namespaces: string[];
}

export interface EventRow {
  type: string;
  reason: string;
  message: string;
  object: ObjRef;
  container: string | null;
  count: number;
  first: number | null;
  last: number | null;
  source: string;
}

export interface NodeAllocation {
  cpu: number | null;
  memory: number | null;
  maxPods: number | null;
  reqCpu: number;
  reqMemory: number;
  limCpu: number;
  limMemory: number;
  pods: number;
  partial: boolean;
}

export interface NodeUsage {
  name: string;
  cpu: number | null;
  cpuPct: number;
  memory: number | null;
  memoryPct: number;
}

export interface NodeSummary {
  name: string;
  ready: 'Ready' | 'NotReady' | 'Unknown';
  readySince?: string;
  roles: string[];
  cordoned: boolean;
  problems: { type: string; reason?: string; message?: string }[];
  taints: string[];
  version?: string;
  os: string;
  arch?: string;
  runtime?: string;
  instanceType: string | null;
  zone: string | null;
  created: string;
  alloc: NodeAllocation;
  usage: NodeUsage | null;
}

export interface PodRow {
  namespace: string;
  name: string;
  phase: string;
  status: string;
  ready: string;
  restarts: number;
  lastRestart: number | null;
  node: string | null;
  ip: string | null;
  qos: string | null;
  created: string;
  owner: { kind: string; name: string } | null;
  cpu: number | null;
  memory: number | null;
  reqCpu: number;
  reqMemory: number;
  limMemory: number;
  images: string[];
  problems: string[];
}

export interface WorkloadCondition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  since?: string;
}

export interface WorkloadRow {
  kind: 'Deployment' | 'StatefulSet' | 'DaemonSet' | 'Job' | 'CronJob';
  namespace: string;
  name: string;
  status: string;
  desired: number | null;
  ready: number;
  updated: number | null;
  images: string[];
  created: string;
  schedule: string | null;
  lastSchedule: string | null;
  lastSuccess: string | null;
  conditions: WorkloadCondition[];
  pods: string[];
  problems: string[];
}

export interface NamespaceRow {
  name: string;
  phase: string;
  created: string | null;
  pods: { total: number; running: number; pending: number; failed: number; succeeded: number };
  restarts: number;
  workloads: number;
  problems: string[];
}

export interface Inventory {
  pods: PodRow[];
  workloads: WorkloadRow[];
  namespaces: NamespaceRow[];
}

export type CoverageStatus = 'ok' | 'partial' | 'forbidden' | 'unsupported' | 'error';

export interface CoverageEntry {
  key: string;
  resource: string;
  status: CoverageStatus;
  count: number;
  scope?: string;
  ms: number;
  kind?: string;
  message?: string;
  detail?: string;
}

export interface HealthCheck {
  name: string;
  ok: boolean;
  message: string;
}

export interface ApiHealth {
  ok: boolean | null;
  checks: HealthCheck[];
  error?: { kind: string; message: string; detail?: string };
}

export interface ContextInfo {
  context: string;
  cluster?: string;
  user?: string;
  namespace: string;
  server?: string;
}

export interface ReportMeta extends ContextInfo {
  version: string | null;
  scannedNamespace: string | null;
  scannedAt: string;
  durationMs: number;
  metricsAvailable: boolean;
  metricsError: string | null;
  health?: ApiHealth;
}

export interface CategoryCount {
  name: string;
  findings: number;
  pods: number;
  severity: Severity;
}

export interface Summary {
  severity: Record<Severity, number>;
  categories: CategoryCount[];
  incidents: number;
  nodes: { total: number; ready: number; cordoned: number };
  pods: { total: number; running: number; pending: number; failed: number; succeeded: number; withProblems: number };
  namespaces: number;
  namespacesWithProblems: string[];
}

export interface Report {
  meta: ReportMeta;
  summary: Summary;
  incidents: Incident[];
  findings: Finding[];
  events: { rows: EventRow[]; total: number; warnings: number };
  nodes: NodeSummary[];
  inventory: Inventory;
  namespaces: string[];
  coverage: CoverageEntry[];
  internalErrors: { where: string; message: string }[];
  demo?: boolean;
}

export interface ContextsResponse {
  contexts: string[];
  current: string | null;
  demo: boolean;
  kubectl: string;
}

export interface ApiErrorBody {
  error: string;
  kind?: string;
  hint?: string | null;
  detail?: string | null;
}

// ------------------------------------------------------------ deep analysis

export interface LogAnalysisSummary {
  matches: (LogMatch & { weight: number; fixes: string[]; lineNo: number })[];
  errorLines: { lineNo: number; text: string }[];
  lastException: string | null;
  empty: boolean;
  lineCount: number;
}

export type LogEntry = { text: string; analysis: LogAnalysisSummary } | { error: string };

export interface Hypothesis {
  title: string;
  summary: string;
  details: string[];
  confidence: number;
  severity: Severity;
  evidence: string[];
  fixes: string[];
  category: string;
  tags: string[];
  container?: string | null;
  fromLogs?: boolean;
  link?: ObjRef;
}

export interface ContainerState {
  state: 'running' | 'waiting' | 'terminated';
  since?: string;
  reason?: string;
  message?: string;
  exitCode?: number;
  signal?: number;
  started?: string;
  finished?: string;
}

export interface ContainerSummary {
  name: string;
  init: boolean;
  sidecar: boolean;
  image: string;
  imageID: string | null;
  ready: boolean;
  started: boolean | null;
  restarts: number;
  state: ContainerState | null;
  lastState: ContainerState | null;
  command: string[] | null;
  args: string[] | null;
  ports: string[];
  resources: { requests?: Record<string, string>; limits?: Record<string, string> };
  usage: { cpu: number | null; memory: number | null } | null;
  probes: { liveness: string | null; readiness: string | null; startup: string | null };
  env: { name: string; value: string | null; from: string | null }[];
  envFrom: string[];
  mounts: string[];
  securityContext: Record<string, unknown> | null;
}

export interface TimelineItem {
  time: number;
  kind: 'pod' | 'condition' | 'container' | 'event' | 'log';
  text: string;
  severity: 'ok' | 'info' | 'warning' | 'critical';
}

export interface DeepAnalysis {
  pod: {
    name: string;
    namespace: string;
    phase: string;
    reason: string | null;
    message: string | null;
    node: string | null;
    podIP: string | null;
    qos: string;
    serviceAccount: string;
    restartPolicy: string;
    priorityClass: string | null;
    created: string;
    deleting: string | null;
    owners: string[];
    labels: Record<string, string>;
    conditions: { type: string; status: string; reason?: string; message?: string; since?: string }[];
    requests: { cpu: number; memory: number };
    limits: { cpu: number; memory: number };
    volumes: { name: string; type?: string; source: string | null }[];
  };
  node: {
    name: string;
    conditions: { type: string; status: string; reason?: string; message?: string }[];
    arch?: string;
    kubelet?: string;
    allocatable?: Record<string, string>;
    taints: string[];
    unschedulable: boolean;
  } | null;
  containers: ContainerSummary[];
  findings: Finding[];
  hypotheses: Hypothesis[];
  dependencies: { container: string; source: string; host: string; port: number | null; count: number; sample: string; resolved: ResolvedDependency | null; health: { pods: number; ready: number; selector: boolean } | null }[];
  services: { name: string; type?: string; ports: string[]; ready: number | null; pods: number | null }[];
  timeline: TimelineItem[];
  events: { type: string; reason: string; message: string; count: number; first: number; last: number; container: string | null }[];
  logs: Record<string, { current: LogEntry | null; previous: LogEntry | null }>;
  metricsAvailable: boolean;
  commands: string[];
  analyzedAt: string;
}
