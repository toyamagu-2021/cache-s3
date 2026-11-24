# S3 tuning, prefix override, progress logging, and debug diagnostics

Users configure S3 backend behavior via environment variables for custom key prefixes (`CACHE_S3_PREFIX`), concurrent `Range` downloads (`CACHE_S3_DOWNLOAD_PART_SIZE`, `CACHE_S3_DOWNLOAD_QUEUE_SIZE`), per-attempt download timeouts (`CACHE_S3_DOWNLOAD_TIMEOUT_MS`), ambient AWS credential clearing (`CACHE_S3_UNSET_AWS_CREDENTIALS`), and path-style fallback (`AWS_S3_FORCE_PATH_STYLE`). During transfers, the action logs upload part progress (`Uploaded part X/Y`) and download progress (`Received X of Y (Z%), N MB/s`), and when `RUNNER_DEBUG=1` is set it emits `::debug::` diagnostics and lists archive contents via `tar -t`.

## Sub-features

- `s3-custom-prefix` stores and restores objects under `<CACHE_S3_PREFIX>/<ref>/<version>/<key>` (with leading/trailing slashes trimmed) instead of `cache/<owner>/<repo>/<ref>/<version>/<key>`.
- `s3-concurrent-range-download` splits downloads larger than `CACHE_S3_DOWNLOAD_PART_SIZE` into concurrent HTTP `Range` (`206 Partial Content`) requests and logs `Received X of Y (Z%), N MB/s`.
- `s3-upload-progress` logs `Uploaded part X/Y` during S3 uploads.
- `s3-debug-archive-listing` logs `::debug::Resolved Keys:`, `::debug::Cache Paths:`, `::debug::Archive Path:`, and lists archive entries (`tar -t`) when `RUNNER_DEBUG=1`.

## How to get to it (user POV)

- Set `env:` variables on any `toyamagu-2021/cache-s3` step (`CACHE_S3_PREFIX`, `CACHE_S3_DOWNLOAD_PART_SIZE`, `CACHE_S3_DOWNLOAD_QUEUE_SIZE`, `CACHE_S3_DOWNLOAD_TIMEOUT_MS`, `CACHE_S3_UNSET_AWS_CREDENTIALS`, `AWS_S3_FORCE_PATH_STYLE`).
- Enable GitHub Actions step debug logging (`RUNNER_DEBUG=1`).

## Driving it with control-cache-s3

Preconditions:

- `node .agents/skills/verify/scripts/control-cache-s3.mjs doctor --run-dir "$RUN_DIR"` reports `"healthy": true`.

- **Save with custom `CACHE_S3_PREFIX` and verify upload progress.** Create a payload and save with `--env "CACHE_S3_PREFIX=/custom-org/custom-prefix/"`. Run `mkdir -p "$RUN_DIR/workspace/tuning" && dd if=/dev/urandom of="$RUN_DIR/workspace/tuning/blob.bin" bs=1024 count=16 2>/dev/null` followed by `node .agents/skills/verify/scripts/control-cache-s3.mjs run-action --run-dir "$RUN_DIR" --reset-state --entry save-only --input "key=tuning-k1" --input "path=$RUN_DIR/workspace/tuning" --env "CACHE_S3_PREFIX=/custom-org/custom-prefix/" --evidence-file "$EVIDENCE_DIR/tuning-1-save.json"` and `node .agents/skills/verify/scripts/control-cache-s3.mjs list-objects --run-dir "$RUN_DIR" --prefix "custom-org/custom-prefix/" --evidence-file "$EVIDENCE_DIR/tuning-2-objects.json"`. Exit code is `0`, `stdout` contains `Uploaded part 1/1`, and `list-objects` returns an object whose key starts with `custom-org/custom-prefix/` and ends with `/tuning-k1`.
- **Restore via concurrent `Range` downloads with `RUNNER_DEBUG=1`.** Delete the local directory and restore with a small `CACHE_S3_DOWNLOAD_PART_SIZE` (e.g. `4096`), `CACHE_S3_DOWNLOAD_QUEUE_SIZE=2`, and `RUNNER_DEBUG=1`. Run `rm -rf "$RUN_DIR/workspace/tuning"` followed by `node .agents/skills/verify/scripts/control-cache-s3.mjs run-action --run-dir "$RUN_DIR" --reset-state --entry restore-only --input "key=tuning-k1" --input "path=$RUN_DIR/workspace/tuning" --env "CACHE_S3_PREFIX=custom-org/custom-prefix" --env "CACHE_S3_DOWNLOAD_PART_SIZE=4096" --env "CACHE_S3_DOWNLOAD_QUEUE_SIZE=2" --env "RUNNER_DEBUG=1" --evidence-file "$EVIDENCE_DIR/tuning-3-range-debug-restore.json"`. Exit code is `0`, `outputs["cache-hit"]` is `"true"`, `stdout` contains `Received `, `::debug::Resolved Keys:`, `::debug::Archive Path:`, and `blob.bin` from `tar -t`, `$RUN_DIR/s3-storage/requests.jsonl` contains multiple `GET` entries with non-null `range` values (`bytes=0-4095`, etc.), and `test -f "$RUN_DIR/workspace/tuning/blob.bin"` succeeds.

## Gotchas

- `CACHE_S3_UPLOAD_PART_SIZE` enforces the S3 minimum of `5242880` bytes (5 MiB); smaller values emit a `::warning::` and fall back to 32 MiB.
- `CACHE_S3_DOWNLOAD_TIMEOUT_MS` rejects values above `2147483647` ms (32-bit `setTimeout` limit) with a `::warning::` and falls back to `30000` ms.
- `CACHE_S3_UNSET_AWS_CREDENTIALS=true` deletes `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_SESSION_TOKEN` only when `CACHE_S3_BUCKET` is set; on a local machine without EC2 IMDS / `~/.aws/credentials`, enabling it against the local mock S3 server will fail SDK credential resolution (which is expected and covered by unit tests).
