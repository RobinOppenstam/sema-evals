# Acquisition instructions: `<task-id>`

This is a template, not acquisition evidence.

Record and verify:

1. Primary repository URL and immutable 40-character source commit.
2. Immutable upstream fix URL, merge timestamp, and downloaded patch digest.
3. Primary license file URL plus the completed redistribution review.
4. Exact command used to obtain the source archive and its SHA-256 digest.
5. Exact command used to materialize the pre-fix snapshot without network
   access.
6. Exact command used to populate and verify the offline dependency cache.
7. Visible checks and a separately held hidden validator.
8. Pre-fix failure output digest and post-fix success output digest.
9. Materialize and reset commands that use `WORKFLOW_TASK_WORKSPACE`. The seal
   command will materialize a temporary workspace, modify the declared probe
   file, execute reset, and require the directory digest to return exactly to
   the sealed pre-fix digest.
10. Reviewer identities. The validator reviewer must not be the acquisition
    reviewer.

Do not promote the task manifest until every referenced artifact exists and its
digest matches.
