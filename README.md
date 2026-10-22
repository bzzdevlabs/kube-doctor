# Kube Doctor

A local, **read-only** web app that scans the Kubernetes cluster behind your current kube context, finds every kind of error (OOMKilled, CrashLoopBackOff, ImagePullBackOff, failing probes, unschedulable pods, broken volumes, dead nodes, failing webhooks, warning events…) and works out the **root cause**, including chains such as:

> Ingress returns 503 → Service `shop/api` has no ready endpoints → `api` pods CrashLoopBackOff → their logs say `connection refused 10.96.40.12:5432` → that is Service `data/postgres`, which has 0 ready pods → `postgres-0` is unschedulable → **root cause: PVC `data-postgres-0` uses StorageClass `fast-ssd`, which does not exist.**

It has no dependencies, needs no build step, and never changes anything in your cluster.

## Quick start

Requirements: **Node.js ≥ 18** and a working **`kubectl`** (if `kubectl get pods` works in your terminal, Kube Doctor works).

```bash
cd kube-doctor
npm start            # then open http://127.0.0.1:7420
npm run open         # same, and opens the browser
npm run demo         # try it on a built-in simulated broken cluster (no kubectl needed)
npm test             # run the test suite
```

`npm install` is not needed (there are no dependencies), but running it is harmless.

Options (after `--`, e.g. `npm start -- --port 8080`):

| Option | Env | Default | |
|---|---|---|---|
| `--port <n>` | `PORT` | `7420` | HTTP port |
| `--host <addr>` | `HOST` | `127.0.0.1` | Bind address. Keep it local: the UI shows cluster data and logs. |
| `--kubectl <path>` | `KUBECTL` | `kubectl` | kubectl binary to use |
| `--open` | | | Open the browser |
| `--demo` | `KUBE_DOCTOR_DEMO=1` | | Simulated cluster |

The cluster used is your kubeconfig's current context (`KUBECONFIG` is honoured). Other contexts from your kubeconfig can be picked in the UI; this only adds `--context=<name>` to the commands, your kubeconfig is never modified.

## Read-only and local by design

- Every cluster call goes through one wrapper (`src/kubectl.js`) with an **allowlist**: `get`, `logs`, `top`, `version`, `config current-context|get-contexts|view`. Anything else (`delete`, `apply`, `exec`, `edit`, `patch`, `scale`, `rollout`, `config use-context`, `port-forward`, `-w`/`-f`, `--as`, …) is refused, and this is covered by tests.
- **Secrets and ConfigMaps are never read.** Missing secrets/configmaps/keys are detected from the Kubernetes error messages. Environment values whose name looks sensitive (`*PASSWORD*`, `*TOKEN*`, `*KEY*`…) are masked in the UI; secret-backed values are only shown as a reference.
- The server listens on `127.0.0.1` only, answers `GET` only, rejects foreign `Host` headers (DNS-rebinding protection) and serves the UI with a strict Content-Security-Policy. No external CDN, font or telemetry: nothing leaves your machine.
- kubectl runs without a shell (`execFile`), and every name coming from the browser is validated.

## What it detects

| Area | Problems detected and explained |
|---|---|
| Containers | CrashLoopBackOff, **OOMKilled** (cgroup limit vs. node OOM, JVM `-Xmx`/`MaxRAMPercentage` and Node.js heap vs. limit, usage from metrics), exit-code interpretation (0, 1, 126, 127, 137, 139, 143…), liveness/startup probe kills (probe timing budget, 1s timeouts, CPU throttling, wrong probe port), readiness failures (404, 5xx, timeout, connection refused, wrong scheme), init containers stuck, restarting containers, lifecycle hook errors |
| Images | ImagePullBackOff / ErrImagePull / InvalidImageName: tag not found, auth (with or without imagePullSecrets, incl. ServiceAccount), rate limiting, TLS/x509 (corporate proxy CA), DNS, network, wrong CPU architecture; one shared root cause when a whole registry fails |
| Configuration | CreateContainerConfigError (missing Secret / ConfigMap / key, runAsNonRoot), CreateContainerError / RunContainerError (command not found, exec format error, permission denied, bad mounts) |
| Logs | Reads the previous instance of crashing containers and recognises ~30 failure signatures (JVM/Node/Python OOM, connection refused, DNS, timeouts, TLS, auth failures, missing env/config, missing files/modules, RBAC forbidden, disk full, read-only FS, port in use, Go panic, Python traceback, Spring startup failure…). Hosts/IPs in errors are mapped to in-cluster Services so a crash can be blamed on the dependency that is actually down. |
| Scheduling | Unschedulable pods with our own reasoning on top of the scheduler message: requests larger than any node ("can NEVER be scheduled"), cluster full, nodeSelector/affinity matching no node, untolerated taints, unbound PVCs, cordoned/NotReady nodes, cluster-autoscaler decisions |
| Pods | Evicted (memory / ephemeral-storage, which container used what), stuck Terminating (dead node, finalizers), Unknown, kubelet admission failures, sandbox creation (CNI not ready, IP exhaustion, pause image, runc failures), stuck ContainerCreating, Multi-Attach volume errors, mount failures (NFS, CSI driver missing…) |
| Nodes | NotReady / Unknown (kubelet stopped posting, runtime down, PLEG, CNI), Memory/Disk/PID pressure, NetworkUnavailable, kernel OOM events, high usage, overcommitted limits, max pods, cordoned |
| Workloads | Deployments unavailable / rollout stuck (ProgressDeadlineExceeded), StatefulSet stuck rollouts, DaemonSets not fully running, **FailedCreate** (ResourceQuota, PodSecurity admission, webhook denials, webhook down, missing ServiceAccount, LimitRange, OpenShift SCC), failed Jobs/CronJobs, HPAs that cannot scale (missing metrics-server, missing requests, adapters) or are pinned at max, PDBs blocking drains |
| Network | Services with no endpoints (label-typo detection, scaled-to-zero backends), targetPort mismatches, pending LoadBalancers, Ingress pointing to missing services/ports or unknown IngressClass, Ingresses whose backends are down |
| Storage | PVC Pending (missing/no default StorageClass, provisioner failures, WaitForFirstConsumer), Lost PVCs, Failed/Released PVs, resize problems |
| Cluster | API-server readiness checks, unavailable aggregated APIs (metrics, custom metrics), admission webhooks with `failurePolicy: Fail` whose backend is down, namespaces stuck Terminating, exhausted ResourceQuotas, any other Warning event |

## How the root-cause analysis works

1. **Collect** (read-only, parallel): nodes, namespaces, pods, events, controllers, services, endpoint slices, ingresses, PVC/PV, storage classes, HPA, PDB, quotas, service accounts, API services, webhooks, `kubectl top`, `/readyz`. If you cannot list a resource cluster-wide, Kube Doctor falls back to your context's namespace and shows it in **Scan coverage**.
2. **Diagnose**: rule-based analyzers (`src/analyzer/*.js`) turn statuses, conditions and event messages into findings with a root-cause hypothesis, evidence, fixes and a confidence level. Identical problems on several pods of one workload are grouped.
3. **Read logs** of crashing containers (toggle *Analyze logs*) to upgrade low-confidence diagnoses and discover dependencies.
4. **Correlate**: each finding declares what it depends on (its node, PVC, pods, Service, webhook, quota, APIService, dependency seen in logs…). This builds a cause → effect graph; the findings with no upstream cause become **incidents** in the *Root causes* tab, with the impact chain below them.
5. **Deep analysis** (button on any pod finding): fresh pod state, all its events, logs of every container (current + previous) with highlighted error lines, live usage vs. limits, probes, env, mounts, a timeline, and ranked hypotheses — for example "Dependency postgres is down (92%)".

Fixes are suggestions only: Kube Doctor shows read-only `kubectl` commands to investigate further, and never applies anything.

## Permissions

Your normal kubeconfig user is used. Read access is enough; the built-in `view` ClusterRole covers most of it, plus cluster-scoped reads for nodes and storage. If something is forbidden, that part is skipped and listed in *Scan coverage*. A dedicated read-only role could look like:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: {name: kube-doctor-reader}
rules:
- apiGroups: ["", apps, batch, autoscaling, policy, networking.k8s.io, storage.k8s.io, discovery.k8s.io, apiregistration.k8s.io, admissionregistration.k8s.io]
  resources: [nodes, namespaces, pods, pods/log, events, services, serviceaccounts, persistentvolumeclaims, persistentvolumes, resourcequotas, deployments, replicasets, statefulsets, daemonsets, jobs, cronjobs, horizontalpodautoscalers, poddisruptionbudgets, ingresses, ingressclasses, storageclasses, endpointslices, apiservices, validatingwebhookconfigurations, mutatingwebhookconfigurations]
  verbs: [get, list]
- apiGroups: [metrics.k8s.io]
  resources: [pods, nodes]
  verbs: [get, list]
- nonResourceURLs: ["/readyz", "/readyz/*"]
  verbs: [get]
```

## Troubleshooting

- **"credentials missing or expired"**: log in first in the same terminal (`aws sso login`, `az login` + `kubelogin`, `gcloud auth login`, your OIDC tool). Exec credential plugins must be on the `PATH` of the terminal that runs `npm start`; interactive logins cannot be answered from the app.
- **"API server unreachable"**: VPN, `HTTPS_PROXY`/`NO_PROXY`, firewall. Kube Doctor uses exactly the same kubectl and environment as your terminal.
- **Windows**: works from PowerShell or cmd; if `kubectl` is not an `.exe` on the PATH, pass its full path: `npm start -- --kubectl "C:\tools\kubectl.exe"`.
- **Events**: Kubernetes keeps events for about one hour, so causes that only appear in old events may be missing; the analysis then relies on statuses and logs.
- **Large clusters**: a scan lists every pod and event once; on tens of thousands of pods expect a few seconds. Uncheck *Analyze logs* for the fastest scan.

## Project layout

```
src/server.js            HTTP server (GET only, localhost, CSP) and API
src/kubectl.js           read-only kubectl wrapper (allowlist)
src/collector.js         parallel snapshot of the cluster
src/analyzer/            pods, nodes, workloads, network, storage, cluster, events, logs,
                         knowledge (explanations), index (grouping/correlation), deep (per-pod)
src/demo/                simulated cluster for `npm run demo` and the tests
public/                  UI (vanilla JS/CSS, no build)
test/                    node:test suites
```
