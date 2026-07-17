# Acquisition: qs empty-array cycle handling

- Repository: `https://github.com/ljharb/qs`
- Pre-fix commit: `f3dc5b026c944906b4d132bd6ae5485c0617c07d`
- Upstream fix: `b433a9b1633e1c3348aa53c513589a5bfe47f113`
- License: BSD-3-Clause, primary file
  `https://github.com/ljharb/qs/blob/f3dc5b026c944906b4d132bd6ae5485c0617c07d/LICENSE.md`

Acquire the immutable source archive from:

```text
https://github.com/ljharb/qs/archive/f3dc5b026c944906b4d132bd6ae5485c0617c07d.tar.gz
```

Materialize the pre-fix tree under
`.cache/workflow-value/tasks/qs-empty-array-cycle/pristine`, copy
`visible-check.cjs` to `.workflow-visible/check.cjs`, and generate the production
dependency lock/cache with:

```sh
npm install --package-lock-only --ignore-scripts --omit=dev --cache <cache>
npm ci --ignore-scripts --omit=dev --cache <cache>
rm -rf node_modules
npm ci --offline --ignore-scripts --omit=dev --cache <cache>
```

The task patch is the `lib/stringify.js` portion of the immutable upstream
commit. Run the external hidden validator with `WORKFLOW_TASK_WORKSPACE` set to
the replay workspace. It must exit nonzero before the patch and zero afterward.

Reset is verified by `materialize.mjs`: materialize to a temporary directory,
modify `lib/stringify.js`, run materialize again, and compare the full directory
fingerprint with the sealed pre-fix fingerprint.
