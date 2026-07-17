# Deterministic conformance image

This image exists only to exercise the Docker workflow-runner boundary without
a provider or subscription CLI. It is not a model-harness image and cannot open
the paid-run gate.

Build and pin it locally:

```sh
docker build \
  --file packages/workflow-runner/docker/Dockerfile.conformance \
  --tag sema-evals/workflow-runner-conformance:node22 \
  .
docker image inspect \
  sema-evals/workflow-runner-conformance:node22 \
  --format '{{.Id}}'
```

Run the opt-in integration suite:

```sh
WORKFLOW_RUNNER_DOCKER_TEST=1 \
WORKFLOW_RUNNER_IMAGE=sema-evals/workflow-runner-conformance:node22 \
pnpm vitest run packages/workflow-runner/test/docker.integration.test.ts
```

The suite records the actual image, Docker, seccomp, snapshot, and validator
digests. Fake-sandbox unit tests are not conforming evidence.
