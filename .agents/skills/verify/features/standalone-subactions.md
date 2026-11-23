# Standalone `restore-only` and `save-only` sub-actions

Users who separate cache restoration and cache saving into distinct workflow steps invoke `toyamagu-2021/cache-s3/restore` (`dist/restore-only/index.js`) and `toyamagu-2021/cache-s3/save` (`dist/save-only/index.js`). Unlike the combined action, `restore-only` uses `NullStateProvider` to emit `cache-primary-key` and `cache-matched-key` as step outputs instead of action state, and `save-only` unconditionally saves the cache using its `key` input without checking prior state.

## Sub-features

- `subaction-save-only` saves a cache directly via `dist/save-only/index.js` without reading `STATE_CACHE_KEY` or `STATE_CACHE_RESULT`.
- `subaction-restore-only-outputs` restores a cache via `dist/restore-only/index.js` and emits `cache-hit`, `cache-primary-key`, and `cache-matched-key` to `GITHUB_OUTPUT`.
- `subaction-fail-on-cache-miss` fails the step with exit code `1` and `::error::Failed to restore cache entry. Exiting as fail-on-cache-miss is set.` when `fail-on-cache-miss=true` and no key matches.

## How to get to it (user POV)

- Configure `uses: toyamagu-2021/cache-s3/save@v6` (`save/action.yml` -> `dist/save-only/index.js`).
- Configure `uses: toyamagu-2021/cache-s3/restore@v6` (`restore/action.yml` -> `dist/restore-only/index.js`).

## Driving it with control-cache-s3

Preconditions:

- `node .agents/skills/verify/scripts/control-cache-s3.mjs doctor --run-dir "$RUN_DIR"` reports `"healthy": true`.

- **Save with `save-only`.** Create a directory and run `save-only`. Run `mkdir -p "$RUN_DIR/workspace/standalone" && printf "standalone-payload\n" > "$RUN_DIR/workspace/standalone/data.txt"` followed by `node .agents/skills/verify/scripts/control-cache-s3.mjs run-action --run-dir "$RUN_DIR" --reset-state --entry save-only --input "key=standalone-k1" --input "path=$RUN_DIR/workspace/standalone" --evidence-file "$EVIDENCE_DIR/standalone-1-save.json"`. Exit code is `0` and `stdout` contains `Cache saved with key: standalone-k1`.
- **Restore with `restore-only` and verify outputs.** Remove `$RUN_DIR/workspace/standalone` and run `restore-only`. Run `rm -rf "$RUN_DIR/workspace/standalone"` followed by `node .agents/skills/verify/scripts/control-cache-s3.mjs run-action --run-dir "$RUN_DIR" --reset-state --entry restore-only --input "key=standalone-k2" --input "restore-keys=standalone-" --input "path=$RUN_DIR/workspace/standalone" --evidence-file "$EVIDENCE_DIR/standalone-2-restore.json"`. Exit code is `0`, `outputs["cache-primary-key"]` is `"standalone-k2"`, `outputs["cache-matched-key"]` is `"standalone-k1"`, `outputs["cache-hit"]` is `"false"`, `states` is empty (`{}`), and `cat "$RUN_DIR/workspace/standalone/data.txt"` outputs `standalone-payload`.
- **Enforce `fail-on-cache-miss=true` on miss.** Run `restore-only` with a non-existent key and `fail-on-cache-miss=true`. Run `node .agents/skills/verify/scripts/control-cache-s3.mjs run-action --run-dir "$RUN_DIR" --reset-state --allow-failure --entry restore-only --input "key=missing-key-999" --input "path=$RUN_DIR/workspace/standalone" --input "fail-on-cache-miss=true" --evidence-file "$EVIDENCE_DIR/standalone-3-fail-miss.json"`. `exitCode` is `1` and `stdout` contains `::error::Failed to restore cache entry. Exiting as fail-on-cache-miss is set. Input key: missing-key-999`.

## Gotchas

- `lookup-only=true` is accepted as an input by `restoreImpl.ts`, but when `s3Cache.isS3Available()` is true, `s3Cache.restoreCache(cachePaths, primaryKey, restoreKeys)` does not receive `lookupOnly` and therefore still downloads and extracts the S3 archive while `restoreImpl.ts` logs `Cache found and can be restored from key: <key>`.
- Always pass `--allow-failure` to `control-cache-s3.mjs run-action` when asserting `fail-on-cache-miss=true` so the harness writes the evidence JSON before returning.
