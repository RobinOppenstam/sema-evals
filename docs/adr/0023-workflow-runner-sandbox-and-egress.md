# ADR 0023: Docker isolation and allowlisted provider egress

- Status: accepted
- Date: 2026-07-17

## Context

The workflow-value benchmark executes writable agent harnesses against
repository snapshots. The harness must be able to edit and test the repository,
but it must not read the parent checkout, inherit user instructions or MCP
configuration, write outside the trial workspace, exceed resource ceilings, or
use provider access as general web access.

WSL2 and Linux CI both provide a Docker daemon with Linux namespaces, cgroups,
seccomp, mount controls, and isolated bridge networks. Harness CLI flags remain
useful defense in depth, but they are not the security boundary.

## Decision

Use a pinned OCI runner image and Docker's operating-system isolation as the
execution boundary.

Every trial container is started with:

- a read-only root filesystem;
- all Linux capabilities dropped except the pinned root init/supervisor
  allowlist `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `KILL`, `SETUID`, and `SETGID`;
- `no-new-privileges`;
- the Docker default seccomp policy or a stricter recorded profile;
- explicit memory, CPU, PID, and wall-clock ceilings;
- a bounded writable `tmpfs`;
- an exact repository snapshot mounted read-only at `/snapshot`;
- a size-limited `tmpfs` mounted at `/workspace`;
- an empty, trial-specific home directory;
- no host Docker socket, SSH agent, parent checkout, user home, or global
  configuration mounts; and
- a non-root numeric user.

Before the agent starts, a runner-controlled initialization step copies
`/snapshot` into `/workspace`, makes the tree root-owned and read-only, grants
the non-root trial user write access only to declared paths, and then drops
privilege. The `tmpfs-size` option is the in-command disk ceiling: exhaustion
returns `ENOSPC`. Post-command tree and size checks are additional evidence,
not the enforcement boundary.

Allowed and prohibited path policy is therefore enforced twice: Unix ownership
and mode bits inside the private mount prevent unauthorized writes, and the
runner rejects the trial if the final tree contains an unauthorized change or
a prohibited path changed.

The root-owned supervisor uses its minimal capability allowlist only to prepare
ownership, terminate escaped/background trial processes, and launch the tracee
as the non-root trial user. Agent processes receive no capabilities.

Process execution is recorded inside the runner image with `strace -ff
-e trace=process`. A conforming image must contain the pinned harness binary,
Node.js 22 or newer, the task's offline dependency material, Git, `setpriv`,
and `strace`. Image conformance runs `strace` as the same non-root user and
under the same dropped-capability and seccomp policy used for trials. If the
trace does not contain the expected child `execve`, the image fails closed;
the runner never adds `SYS_PTRACE` merely to make tracing pass. Trace output is
written below a root-owned directory that the tracee cannot read, modify, or
delete. Missing or empty traces are control failures, never normal telemetry.
The image
digest and tool versions are part of every result manifest.

### Egress

Offline setup, validators, deterministic adapters, and fake harnesses use
Docker `--network none`.

Provider-backed harnesses use two Docker networks:

1. an internal trial network, to which the trial and proxy containers attach;
2. a non-internal egress network, to which only the proxy attaches.

The trial receives only the proxy address. The proxy configuration contains a
frozen hostname and port allowlist for the selected provider, denies CONNECT to
IP literals and every unlisted destination, disables response caching, caps
request and response bodies, and records destination, method, status, byte
counts, and policy digest. DNS resolution happens in the proxy, not in the
trial container.

The harness adapter must also disable browser, web-search, URL-fetch, MCP, and
plugin tools. Provider endpoints are allowed solely for model invocation. A
harness that cannot disable provider-side browsing or arbitrary URL-fetch is
non-conforming and cannot run the benchmark.

The proxy image, configuration digest, resolved provider allowlist, and runner
image digest are frozen for a run series. The runner fails closed if Docker,
cgroup controls, the pinned images, the seccomp profile, `strace`, the isolated
home, or the required proxy policy is unavailable.

## Budget enforcement

Each harness declares one channel before use:

- `streaming-tokens`, with an enforceable token ceiling; or
- `turn-wall-clock-proxy`, with fixed turn and wall-clock ceilings and
  post-hoc token telemetry.

Cross-harness results remain separate. A post-hoc token count cannot be
described as an enforced token budget.

## Result preservation

The agent container has no evidence mount. `/home/agent` and `/tmp` are bounded
ephemeral tmpfs mounts required by the named harness; they are explicit audited
harness-state exceptions, are never score-bearing workspace paths, and are
extracted and digested after the run. A task may additionally receive a sealed
dependency cache mounted read-only at `/workflow-cache-sealed`. Trusted setup
copies it into a bounded disposable `/workflow-cache` tmpfs. The runner freezes
that copy read-only before the baseline checkpoint and before agent execution.
Any other writable mount is a control failure.

After a checkpoint or terminal
state, the outer runner copies the workspace and process trace out through the
Docker API into a runner-owned staging directory that is never visible inside
the container. Before extraction the runner verifies that no harness child or
daemon remains. With only the inert PID 1 sleep process left, a root-owned tar
stream extracts the tmpfs atomically with respect to agent activity; the agent
cannot race or modify the archive. The scorer creates the initial tree,
checkpoint trees, final
tree, stdout/stderr, complete harness transcript, final patch, validator
results, proxy log, and control metadata from that staging area. Setup failures,
timeouts, nonzero exits, malformed outputs, resource violations, and validator
failures produce complete failed bundles.

Workspaces are deleted only after the evidence bundle has been finalized and
verified. A retention flag may keep the isolated workspace for debugging; it
never changes scoring.

## WSL2 and CI validation

The common conformance suite directly exercises:

- read-only root and non-root execution;
- parent/home isolation;
- unauthorized write rejection;
- `--network none` denial;
- allowlisted-proxy denial of an unlisted destination;
- PID, memory, disk, and wall-clock ceilings;
- `ENOSPC` while a command is still running after the bounded workspace fills;
- non-root process tracing under the frozen seccomp/capability policy;
- nonzero exit and timeout preservation; and
- byte-identical reset from the immutable snapshot.

CI does not make provider calls. It uses deterministic and fake harnesses with
network disabled and a fake proxy policy parser. A separately triggered,
credentialed integration job may exercise the real pinned proxy path without
performing benchmark trials.

## Consequences

- Docker is an explicit prerequisite for writable repository runs.
- The runner can be developed and tested without paid model calls.
- Subscription CLI binaries must be packaged in a pinned runner image rather
  than inherited from the host.
- Provider allowlisting is a network property, not a prompt promise.
- A local process runner may be used for unit tests, but it is never marked
  conforming evidence.

## Rejected alternatives

### Trust harness sandbox flags

Rejected because those flags cannot isolate the host home, enforce cgroups, or
provide a provider-only egress boundary.

### Unshare namespaces directly

Rejected as the primary mechanism because unprivileged user/network namespace
availability differs across WSL2 and hosted CI, and cgroup delegation is not
reliably available to the repository process.

### Fully air-gapped execution

Rejected for subscription harnesses because they require provider API access.
It remains the required mode for setup, validators, and deterministic tests.

### Host firewall rules

Rejected because they require elevated global mutation, are difficult to scope
per concurrent trial, and are not portable to shared CI workers.
