# Ref-scoped caches and restore fallback (`GITHUB_REF`)

Caches are stored under the ref of the workflow run, at `cache/<owner>/<repo>/<ref>/<version>/<key>`. A restore searches the current ref, then the pull request base branch (`GITHUB_BASE_REF`), then the default branch (from the `GITHUB_EVENT_PATH` payload or `CACHE_S3_DEFAULT_BRANCH`), so a pull request can reuse a default-branch cache while sibling branches never see each other's caches.

## Sub-features

- `ref-scoped-save` stores the object under the current `GITHUB_REF` (for example `refs/heads/main/`).
- `ref-fallback-base-branch` restores a cache saved on `refs/heads/main` from `refs/pull/<n>/merge` when `GITHUB_BASE_REF=main`.
- `ref-sibling-isolation` does not restore a cache saved on `refs/heads/feature-a` from `refs/heads/feature-b` when the only fallback is the default branch `main`.

## How to get to it (user POV)

- Run any `toyamagu-2021/cache-s3` step on a push or pull request workflow. The runner sets `GITHUB_REF`, `GITHUB_BASE_REF`, and `GITHUB_EVENT_PATH`.
- Set `env: CACHE_S3_DEFAULT_BRANCH` when the event payload has no `repository.default_branch`.

## Driving it with control-cache-s3

Preconditions:

- `node .agents/skills/verify/scripts/control-cache-s3.mjs doctor --run-dir "$RUN_DIR"` reports `"healthy": true`.
- `run-action` sets `GITHUB_REF=refs/heads/main` by default. `--env` values override it, and `--env "GITHUB_BASE_REF="` clears a base ref inherited from the calling shell.

- **Save on `refs/heads/main`.** Run `mkdir -p "$RUN_DIR/workspace/scoped" && echo from-main > "$RUN_DIR/workspace/scoped/file.txt"` followed by `node .agents/skills/verify/scripts/control-cache-s3.mjs run-action --run-dir "$RUN_DIR" --reset-state --entry save-only --input "key=scoped-main" --input "path=$RUN_DIR/workspace/scoped" --env "GITHUB_REF=refs/heads/main" --evidence-file "$EVIDENCE_DIR/scope-1-save-main.json"` and `node .agents/skills/verify/scripts/control-cache-s3.mjs list-objects --run-dir "$RUN_DIR" --prefix "cache/toyamagu-2021/cache-s3/refs/heads/main/" --evidence-file "$EVIDENCE_DIR/scope-2-objects.json"`. Exit code is `0` and `list-objects` returns one key matching `cache/toyamagu-2021/cache-s3/refs/heads/main/<64 hex>/scoped-main`.
- **Restore the `main` cache from a pull request ref.** Run `rm -rf "$RUN_DIR/workspace/scoped"` followed by `node .agents/skills/verify/scripts/control-cache-s3.mjs run-action --run-dir "$RUN_DIR" --reset-state --entry restore-only --input "key=scoped-main" --input "path=$RUN_DIR/workspace/scoped" --env "GITHUB_REF=refs/pull/1/merge" --env "GITHUB_BASE_REF=main" --env "RUNNER_DEBUG=1" --evidence-file "$EVIDENCE_DIR/scope-3-restore-pr.json"`. Exit code is `0`, `outputs["cache-hit"]` is `"true"`, `stdout` contains `::debug::Cache found in scope refs/heads/main`, and `cat "$RUN_DIR/workspace/scoped/file.txt"` outputs `from-main`.
- **Save on `refs/heads/feature-a`.** Run `mkdir -p "$RUN_DIR/workspace/sibling" && echo from-feature-a > "$RUN_DIR/workspace/sibling/file.txt"` followed by `node .agents/skills/verify/scripts/control-cache-s3.mjs run-action --run-dir "$RUN_DIR" --reset-state --entry save-only --input "key=scoped-feature" --input "path=$RUN_DIR/workspace/sibling" --env "GITHUB_REF=refs/heads/feature-a" --evidence-file "$EVIDENCE_DIR/scope-4-save-feature-a.json"`. Exit code is `0`, and `list-objects --prefix "cache/toyamagu-2021/cache-s3/refs/heads/feature-a/"` returns one key ending in `/scoped-feature`.
- **Sibling branch misses.** Run `rm -rf "$RUN_DIR/workspace/sibling"` followed by `node .agents/skills/verify/scripts/control-cache-s3.mjs run-action --run-dir "$RUN_DIR" --reset-state --entry restore-only --input "key=scoped-feature" --input "path=$RUN_DIR/workspace/sibling" --env "GITHUB_REF=refs/heads/feature-b" --env "GITHUB_BASE_REF=" --env "CACHE_S3_DEFAULT_BRANCH=main" --evidence-file "$EVIDENCE_DIR/scope-5-restore-feature-b.json"`. Exit code is `0`, `outputs` has no `cache-hit`, `stdout` contains `Cache not found for input keys: scoped-feature`, `$RUN_DIR/workspace/sibling/file.txt` does not exist, and `$RUN_DIR/s3-storage/requests.jsonl` shows `ListObjectsV2` prefixes for `refs/heads/feature-b/` and then `refs/heads/main/` only.

## Gotchas

- The harness inherits the calling shell's environment. Inside a GitHub Actions job, `GITHUB_BASE_REF` and `GITHUB_EVENT_PATH` leak into the child unless overridden with `--env`.
- `GITHUB_REF` empty or unset makes every S3 step fail with `GITHUB_REF is not set`.
