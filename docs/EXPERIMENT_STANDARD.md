# Experiment standard

This is the minimum run contract for evidence published by `sema-evals`.

## Before running

Write down:

- hypothesis and predicted direction;
- primary endpoint;
- experimental unit and pairing/blocking strategy;
- conditions and the effect isolated by each comparison;
- sample size and stopping rule;
- exclusions and failure handling;
- model, tool, evidence, turn, and token budgets;
- analysis method and planned uncertainty interval.

Exploratory runs must be labelled exploratory. A hypothesis written after
seeing results is not preregistration.

## Information parity

For the equal-information prose and content-addressed conditions:

- use byte-identical semantic definitions after resolution;
- hold tools, evidence, output schemas, and budgets constant;
- control compact lookup with an opaque-ID resolver;
- record cache state and hydration separately;
- do not add reasoning instructions only to the Sema arm.

## Randomization and pairing

Every condition runs on the same scenario/seed blocks. Condition order is
shuffled by a recorded order seed. Provider retry policy must not selectively
drop inconvenient outputs.

## Scoring

Prefer executable validators and known ground truth. If judgment is necessary:

- remove condition-identifying material;
- use a fixed rubric;
- report inter-rater disagreement;
- retain the original response;
- do not make an LLM judge the only source of truth.

## Required telemetry

- scenario, condition, repetition seed, and trial ID;
- input/output transcript or its redacted public derivative;
- semantic definitions and references used at every boundary;
- verification, repair, continuation, and halt events;
- wire and hydration bytes;
- model input, cached-input, reasoning, and output tokens when available;
- tool calls, latency, retries, errors, and cost;
- outcome metrics and scorer version.

## Required provenance

- protocol and artifact-schema versions;
- dataset and fixture digest;
- prompt digest;
- code commit and dirty-tree marker;
- Sema package version, canonicalization version, and vocabulary root;
- model provider, exact model identifier, and provider date/snapshot where
  available;
- dependency lockfile digest.

## Reporting

Report counts as well as rates. Include uncertainty intervals for inferential
claims and effect sizes for paired comparisons. Never hide malformed outputs,
timeouts, provider failures, or negative results.

Distinguish explicitly between:

- deterministic harness validation;
- exploratory model pilot;
- preregistered confirmatory experiment;
- historical forecast replay;
- paper execution;
- live deployment.
