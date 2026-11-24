# `cache-s3` verification map

This directory is the maintained source for verifying the user-facing behavior of `toyamagu-2021/cache-s3`. Read this index before driving the action, then use the matching feature file as the recipe.

## Baseline preconditions

- Build the action bundles (`pnpm build`) so `dist/restore/index.js`, `dist/save/index.js`, `dist/restore-only/index.js`, and `dist/save-only/index.js` reflect the current worktree.
- Set a unique `RUN_ID="run-$(date +%s)-$$"`, `RUN_DIR="/tmp/cache-s3-verify-$RUN_ID"`, and `EVIDENCE_DIR="/tmp/cache-s3-evidence-$RUN_ID"`.
- Start an isolated S3-compatible server instance with `node .agents/skills/verify/scripts/control-cache-s3.mjs start-s3 --run-dir "$RUN_DIR"`.
- Run `node .agents/skills/verify/scripts/control-cache-s3.mjs doctor --run-dir "$RUN_DIR"` and require `"healthy": true`.
- Never drive an S3 server instance that was not started by the current verification run.

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise.
- Treat every command as literal. Keep quoted input keys and flags unchanged.
- Run action steps through `node .agents/skills/verify/scripts/control-cache-s3.mjs run-action --run-dir "$RUN_DIR" ...`.
- Inspect S3 bucket state through `node .agents/skills/verify/scripts/control-cache-s3.mjs list-objects --run-dir "$RUN_DIR" ...`.
- Pass `--reset-state` when starting a new simulated GitHub Actions job so `STATE_CACHE_KEY` and `STATE_CACHE_RESULT` from previous jobs do not leak.
- Do not remove proof artifacts in `$EVIDENCE_DIR` during cleanup.

## Proof and skip reporting

- Capture both the action step execution (`--evidence-file "$EVIDENCE_DIR/<step>.json"`) and the resulting state.
- Step proof includes `entry`, `exitCode`, `inputs`, `outputs`, `states`, `stdout`, and `stderr`.
- Mutation proof for cache save includes a second read-only view via `list-objects` confirming the S3 object key (`cache/<owner>/<repo>/<ref>/<version>/<key>`) and byte size, plus a restore verification after deleting the cached directory on disk.
- Record the feature ID and entry point used with every artifact.
- Report an unreachable path with the attempted command and the unmet precondition.
- Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order:

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with control-cache-s3` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

Keep implementation details out of the map. Name only user paths, stable handles, required state, commands, and observable proof.

## Features

- [S3 roundtrip (`restore` + `save`)](./s3-roundtrip.md) covers primary action cache miss, post-step S3 upload, subsequent exact-key cache hit, and post-step skip on exact hit.
- [Restore keys prefix fallback (`restore-keys`)](./restore-keys-fallback.md) covers restoring a stale prefix-matched S3 cache when the primary key misses, verifying `cache-hit: false`, and saving a new cache under the primary key.
- [Standalone `restore-only` and `save-only` sub-actions](./standalone-subactions.md) covers independent save (`save/action.yml`) and restore (`restore/action.yml`) with `cache-primary-key`, `cache-matched-key`, and `cache-hit` outputs and `fail-on-cache-miss` handling.
- [Compression and archive fidelity (`zstd` vs `gzip` and symlinks)](./compression-and-archives.md) covers `zstd` vs `gzip` cache version partitioning and symlink preservation without duplicate directory expansion.
- [Ref-scoped caches and restore fallback (`GITHUB_REF`)](./ref-scoping.md) covers saving under the current ref, restoring a default-branch cache from a pull request ref, and isolating sibling branches.
- [S3 tuning, prefix override, progress logging, and debug diagnostics](./s3-tuning-and-diagnostics.md) covers `CACHE_S3_PREFIX`, concurrent `Range` downloads (`CACHE_S3_DOWNLOAD_PART_SIZE` / `CACHE_S3_DOWNLOAD_QUEUE_SIZE`), upload/download progress logs, and `RUNNER_DEBUG=1` archive listing.
