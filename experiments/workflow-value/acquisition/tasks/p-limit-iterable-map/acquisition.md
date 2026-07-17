# Acquisition: p-limit iterable map

- Repository: `https://github.com/sindresorhus/p-limit`
- Pre-fix commit: `9da5934aaf15c22fceca470ad28ed5720b3c7340`
- Upstream fix: `d76231b44ec6693212bcf245e57b7b95cfc93297`
- License: MIT, primary file
  `https://github.com/sindresorhus/p-limit/blob/9da5934aaf15c22fceca470ad28ed5720b3c7340/license`

Acquire the immutable source archive from:

```text
https://github.com/sindresorhus/p-limit/archive/9da5934aaf15c22fceca470ad28ed5720b3c7340.tar.gz
```

Materialize the pre-fix tree under
`.cache/workflow-value/tasks/p-limit-iterable-map/pristine`, copy
`visible-check.mjs` to `.workflow-visible/check.mjs`, and generate the production
dependency lock/cache with:

```sh
npm install --package-lock-only --ignore-scripts --omit=dev --cache <cache>
npm ci --ignore-scripts --omit=dev --cache <cache>
rm -rf node_modules
npm ci --offline --ignore-scripts --omit=dev --cache <cache>
```

The task patch is the `index.js` portion of the immutable upstream commit. Run
the external hidden validator with `WORKFLOW_TASK_WORKSPACE` set to the replay
workspace. It must exit nonzero before the patch and zero afterward.

Reset is verified by `materialize.mjs`: materialize to a temporary directory,
modify `index.js`, run materialize again, and compare the full directory
fingerprint with the sealed pre-fix fingerprint.
