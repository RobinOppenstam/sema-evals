# Acquisition: p-map out-of-order index

- Repository: `https://github.com/sindresorhus/p-map`
- Pre-fix commit: `65aaa8f4d7e757a5254a146c4c39403efa9e2139`
- Upstream fix: `1af51b57534b284ead73cca65f26b56bb9390768`
- License: MIT, primary file
  `https://github.com/sindresorhus/p-map/blob/65aaa8f4d7e757a5254a146c4c39403efa9e2139/license`

Acquire the immutable source archive from:

```text
https://github.com/sindresorhus/p-map/archive/65aaa8f4d7e757a5254a146c4c39403efa9e2139.tar.gz
```

Materialize the pre-fix tree under
`.cache/workflow-value/tasks/p-map-out-of-order-index/pristine`, copy
`visible-check.mjs` to `.workflow-visible/check.mjs`, and copy
`empty-runtime-dependencies.json` to `.workflow-dependency-lock.json` and the
offline cache. The task has no runtime package dependency.

The task patch is the `index.js` portion of the immutable upstream commit. Run
the external hidden validator with `WORKFLOW_TASK_WORKSPACE` set to the replay
workspace. It must exit nonzero before the patch and zero afterward.

Reset is verified by `materialize.mjs`: materialize to a temporary directory,
modify `index.js`, run materialize again, and compare the full directory
fingerprint with the sealed pre-fix fingerprint.
