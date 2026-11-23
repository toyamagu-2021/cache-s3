# Restore keys prefix fallback (`restore-keys`)

When the exact `key` is not found in S3, `cache-s3` searches each prefix in `restore-keys` in order via `ListObjectsV2`, restores the most recently modified matching S3 object, sets `cache-hit` to `"false"`, and saves a fresh cache under the new primary `key` during the post `save` step.

## Sub-features

- `fallback-restore` matches a prefix in `restore-keys` when `key` misses, downloads the latest matching object, and sets `cache-hit` to `"false"`.
- `fallback-latest-selection` selects the object with the newest `LastModified` timestamp when multiple S3 objects share a `restore-keys` prefix.
- `fallback-post-save` uploads a new cache object under the primary `key` in the post step because `CACHE_RESULT` differs from `CACHE_KEY`.

## How to get to it (user POV)

- Configure `uses: toyamagu-2021/cache-s3@v6` (or `toyamagu-2021/cache-s3/restore@v6`) with `key` and a multiline `restore-keys` input.

## Driving it with control-cache-s3

Preconditions:

- `node .agents/skills/verify/scripts/control-cache-s3.mjs doctor --run-dir "$RUN_DIR"` reports `"healthy": true`.
- Target path `$RUN_DIR/workspace/deps` is used consistently across save and restore (the `path` list is hashed into the S3 prefix version).

- **Seed an older and newer cache under prefix `deps-v1-`.** Create v1 content, save under `deps-v1-old`, wait 1 second, update content, and save under `deps-v1-new`. Run:
  `mkdir -p "$RUN_DIR/workspace/deps" && printf "v1-old\n" > "$RUN_DIR/workspace/deps/lock.txt"`
  `node .agents/skills/verify/scripts/control-cache-s3.mjs run-action --run-dir "$RUN_DIR" --reset-state --entry save-only --input "key=deps-v1-old" --input "path=$RUN_DIR/workspace/deps" --evidence-file "$EVIDENCE_DIR/fallback-1-seed-old.json"`
  `sleep 1 && printf "v1-new\n" > "$RUN_DIR/workspace/deps/lock.txt"`
  `node .agents/skills/verify/scripts/control-cache-s3.mjs run-action --run-dir "$RUN_DIR" --reset-state --entry save-only --input "key=deps-v1-new" --input "path=$RUN_DIR/workspace/deps" --evidence-file "$EVIDENCE_DIR/fallback-2-seed-new.json"`.
  Both steps exit `0`.
- **Restore with a new primary key and `restore-keys: deps-v1-`.** Delete `$RUN_DIR/workspace/deps` and run `restore` with `key=deps-v1-target` and `restore-keys=deps-v1-`. Run `rm -rf "$RUN_DIR/workspace/deps"` followed by `node .agents/skills/verify/scripts/control-cache-s3.mjs run-action --run-dir "$RUN_DIR" --reset-state --entry restore --input "key=deps-v1-target" --input "restore-keys=deps-v1-" --input "path=$RUN_DIR/workspace/deps" --evidence-file "$EVIDENCE_DIR/fallback-3-restore.json"`. Exit code is `0`, `outputs["cache-hit"]` is `"false"`, `states.CACHE_KEY` is `"deps-v1-target"`, `states.CACHE_RESULT` is `"deps-v1-new"`, `stdout` contains `Cache restored from key: deps-v1-new`, and `cat "$RUN_DIR/workspace/deps/lock.txt"` outputs `v1-new`.
- **Save new primary key in post step.** Modify `$RUN_DIR/workspace/deps/lock.txt` and run the post `save` step in the same job state. Run `printf "v1-target\n" > "$RUN_DIR/workspace/deps/lock.txt"` followed by `node .agents/skills/verify/scripts/control-cache-s3.mjs run-action --run-dir "$RUN_DIR" --entry save --input "key=deps-v1-target" --input "path=$RUN_DIR/workspace/deps" --evidence-file "$EVIDENCE_DIR/fallback-4-post-save.json"`. Exit code is `0`, `stdout` contains `Cache saved with key: deps-v1-target`, and `list-objects` now shows three objects (`deps-v1-old`, `deps-v1-new`, `deps-v1-target`).

## Gotchas

- The S3 prefix includes `sha256([...paths, compression, "1.1"].join("|"))`. If `path` differs even slightly between `save` and `restore`, the version hash changes and `restore-keys` will not find the object.
- When `LastModified` timestamps tie to the same millisecond, sort order is not guaranteed; sleep at least 1 second between seeding objects when testing latest-object selection.
