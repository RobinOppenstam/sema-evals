# Acquisition: qs cumulative array limit

- Repository: `https://github.com/ljharb/qs`
- Pre-fix commit: `59da434d5de8c3d2564e4d75aeedde2e8af72369`
- Upstream fix: `963e538c740961a35ecaa0b38ee1f5c16697e208`
- License: BSD-3-Clause, primary file
  `https://github.com/ljharb/qs/blob/59da434d5de8c3d2564e4d75aeedde2e8af72369/LICENSE.md`

Acquire the immutable source archive from:

```text
https://github.com/ljharb/qs/archive/59da434d5de8c3d2564e4d75aeedde2e8af72369.tar.gz
```

Materialize the pre-fix tree under
`.cache/workflow-value/tasks/qs-cumulative-array-limit/pristine`, copy
`visible-check.cjs` to `.workflow-visible/check.cjs`, and generate the production
dependency lock/cache with:

```sh
npm install --package-lock-only --ignore-scripts --omit=dev --cache <cache>
npm ci --ignore-scripts --omit=dev --cache <cache>
rm -rf node_modules
npm ci --offline --ignore-scripts --omit=dev --cache <cache>
```

The task patch modifies both `lib/parse.js` and `lib/utils.js`. The visible
regression and external hidden validator must both exit nonzero before the
patch and zero afterward. Hidden cases cover cumulative comma growth and mixed
index/key notation beyond the visible duplicate-key boundary case.

Reset is verified by `materialize.mjs`: materialize to a temporary directory,
modify `lib/parse.js`, run materialize again, and compare the full directory
fingerprint with the sealed pre-fix fingerprint.
