# S3 roundtrip (`restore` + `save`)

The primary `cache` action (`action.yml`) checks S3 for an existing cache entry during its `main` step (`dist/restore/index.js`), uploads the specified paths to S3 during its `post` step (`dist/save/index.js`) when the primary key was not matched, and skips re-uploading when an exact primary key match occurred.

## Sub-features

- `roundtrip-miss` reports a cache miss without setting `cache-hit` when the key does not exist in S3 and saves `CACHE_KEY` to action state.
- `roundtrip-save` archives the target path and uploads it to `s3://<bucket>/cache/<repo>/<version>/<key>` in the post step.
- `roundtrip-hit` downloads and extracts the archive from S3 on an exact primary key match and sets output `cache-hit` to `"true"`.
- `roundtrip-skip-save` skips uploading in the post step when `CACHE_RESULT` matches `CACHE_KEY`.

## How to get to it (user POV)

- Configure `uses: toyamagu-2021/cache-s3@v6` in a workflow with `CACHE_S3_BUCKET`, `key`, and `path` (runs `dist/restore/index.js` as `main` and `dist/save/index.js` as `post`).

## Driving it with control-cache-s3

Preconditions:

- `node .agents/skills/verify/scripts/control-cache-s3.mjs doctor --run-dir "$RUN_DIR"` reports `"healthy": true`.
- No object with key suffix `roundtrip-v1` exists in the S3 server.

- **Initial restore (cache miss).** Run the main `restore` step for `roundtrip-v1` on a fresh job state. Run `node .agents/skills/verify/scripts/control-cache-s3.mjs run-action --run-dir "$RUN_DIR" --reset-state --entry restore --input "key=roundtrip-v1" --input "path=$RUN_DIR/workspace/cache-dir" --evidence-file "$EVIDENCE_DIR/roundtrip-1-miss.json"`. Exit code is `0`, `stdout` contains `Cache not found for input keys: roundtrip-v1`, `states.CACHE_KEY` is `"roundtrip-v1"`, and `outputs["cache-hit"]` is unset.
- **Populate directory and run post save.** Create files inside `$RUN_DIR/workspace/cache-dir` and run the post `save` step. Run `mkdir -p "$RUN_DIR/workspace/cache-dir/sub" && printf "hello-s3-roundtrip\n" > "$RUN_DIR/workspace/cache-dir/sub/artifact.txt"` followed by `node .agents/skills/verify/scripts/control-cache-s3.mjs run-action --run-dir "$RUN_DIR" --entry save --input "key=roundtrip-v1" --input "path=$RUN_DIR/workspace/cache-dir" --evidence-file "$EVIDENCE_DIR/roundtrip-2-save.json"`. Exit code is `0` and `stdout` contains `Uploading cache to s3://verify-bucket/cache/toyamagu-2021/cache-s3/` and `Cache saved with key: roundtrip-v1`.
- **Confirm S3 object stored.** Query the local S3 server for stored objects. Run `node .agents/skills/verify/scripts/control-cache-s3.mjs list-objects --run-dir "$RUN_DIR" --evidence-file "$EVIDENCE_DIR/roundtrip-3-objects.json"`. The response `objects` array contains 1 entry whose `key` ends with `/roundtrip-v1` and whose `size` is greater than `0`.
- **Delete local files and restore from S3 (cache hit).** Remove `$RUN_DIR/workspace/cache-dir` and run `restore` in a new simulated job. Run `rm -rf "$RUN_DIR/workspace/cache-dir"` followed by `node .agents/skills/verify/scripts/control-cache-s3.mjs run-action --run-dir "$RUN_DIR" --reset-state --entry restore --input "key=roundtrip-v1" --input "path=$RUN_DIR/workspace/cache-dir" --evidence-file "$EVIDENCE_DIR/roundtrip-4-hit.json"`. Exit code is `0`, `outputs["cache-hit"]` is `"true"`, `states.CACHE_RESULT` is `"roundtrip-v1"`, `stdout` contains `Cache restored from key: roundtrip-v1`, and `cat "$RUN_DIR/workspace/cache-dir/sub/artifact.txt"` outputs `hello-s3-roundtrip`.
- **Post save skips on exact hit.** Run the post `save` step in the same job state after the cache hit. Run `node .agents/skills/verify/scripts/control-cache-s3.mjs run-action --run-dir "$RUN_DIR" --entry save --input "key=roundtrip-v1" --input "path=$RUN_DIR/workspace/cache-dir" --evidence-file "$EVIDENCE_DIR/roundtrip-5-skip-save.json"`. Exit code is `0` and `stdout` contains `Cache hit occurred on the primary key roundtrip-v1, not saving cache.`.

## Gotchas

- On a complete cache miss (neither `key` nor `restore-keys` matched), `cache-hit` output is intentionally omitted (not set to `"false"`) to match upstream `actions/cache#1466`.
- `s3Cache.ts` extracts archives with `tar -xf <archive> -C /`, so paths passed to `path` must resolve under a writable directory (such as `$RUN_DIR/workspace/...`).
- Forgetting `--reset-state` when starting the second job leaves `STATE_CACHE_RESULT` from a prior job in the environment.
