# Repository instructions

This repository evaluates semantic coordination mechanisms. Treat research
validity as a product requirement.

## Non-negotiable experiment rules

- Never describe deterministic harness output as evidence that Sema improves
  model performance.
- Keep pattern content identical between equal-information prose and Sema
  conditions. Isolate content, addressing, and enforcement effects.
- Choose and document one primary endpoint before a confirmatory run.
- Preserve every run, including failures, timeouts, and malformed outputs.
- Record prompt, dataset, model, implementation, Sema version, vocabulary root,
  scorer, and protocol fingerprints in result manifests.
- Report wire bytes, hydration/context tokens, and total model tokens
  separately. A short reference is not automatically a context-token saving.
- Prefer deterministic validators. Blind subjective judges to the experiment
  condition and never use an LLM judge as the only scorer.
- Do not use live trading capital in an experiment. Historical replay and paper
  execution come first.

## Engineering rules

- Use pnpm and Node.js 22 or newer.
- Keep TypeScript strict and avoid `any`.
- Put reusable code in `packages/`; experiment-specific policy belongs under
  `experiments/`.
- Generated result bundles belong under `results/` and remain untracked unless
  intentionally promoted into a dated public report.
- Run `pnpm check` before handing off changes.
