---
name: verify
description: Drive and verify toyamagu-2021/cache-s3 (GitHub Action with S3 backend) end-to-end against an isolated local S3-compatible server by running its compiled dist/* bundles (`dist/restore`, `dist/save`, `dist/restore-only`, `dist/save-only`). Reach for this skill whenever changing `src/**`, `action.yml`, `restore/action.yml`, `save/action.yml`, S3 upload/download logic, tar compression pipelines, or bundle packaging.
---

# Verify `cache-s3`

`toyamagu-2021/cache-s3` is a Node.js GitHub Action with four compiled entry points (`dist/restore/index.js`, `dist/save/index.js`, `dist/restore-only/index.js`, `dist/save-only/index.js`). Unit tests (`pnpm test`) mock `@actions/exec`, `@actions/glob`, and `@aws-sdk/*`. This verification skill exercises the real compiled `dist/*` bundles end-to-end against an isolated local S3-compatible server (`control-cache-s3.mjs`), running real `tar` (`gzip` / `zstd`), real `@actions/glob`, real `@aws-sdk/client-s3` + `@aws-sdk/lib-storage` multipart uploads, and real GitHub Actions runner file protocols (`GITHUB_OUTPUT`, `GITHUB_STATE`).

Read [`.agents/skills/verify/features/README.md`](./features/README.md) for the feature map index before driving the action.

## Launch

Build the compiled bundles and launch an isolated S3 server instance in a dedicated run directory (`/tmp/cache-s3-verify-$RUN_ID`):

```bash
export RUN_ID="run-$(date +%s)-$$"
export RUN_DIR="/tmp/cache-s3-verify-$RUN_ID"
export EVIDENCE_DIR="/tmp/cache-s3-evidence-$RUN_ID"
mkdir -p "$EVIDENCE_DIR"

# 1. Build all four ncc bundles if src/ was touched
pnpm build

# 2. Start an isolated local S3-compatible server on an ephemeral port
node .agents/skills/verify/scripts/control-cache-s3.mjs start-s3 --run-dir "$RUN_DIR"
```

The `start-s3` command waits until `GET /__health` returns `200 OK` with `{"ok":true}` and writes `$RUN_DIR/instance.json` and `$RUN_DIR/s3-server.pid`.

## Doctor

Before driving any entry point (or whenever something looks off), run the read-only health check:

```bash
node .agents/skills/verify/scripts/control-cache-s3.mjs doctor --run-dir "$RUN_DIR"
```

`doctor` exits `0` only when:
- `$RUN_DIR/instance.json` exists,
- the recorded S3 server PID is alive and owns the bound endpoint (`GET /__health` returns the matching PID), and
- all four compiled bundles (`dist/restore/index.js`, `dist/save/index.js`, `dist/restore-only/index.js`, `dist/save-only/index.js`) exist.

Never drive an instance that was not started by the current verification run. `start-s3` refuses to overwrite a live PID in the same `--run-dir`.

## Drive

Drive the compiled bundles via `.agents/skills/verify/scripts/control-cache-s3.mjs`:

```bash
# Run any of the 4 action entry points: restore | save | restore-only | save-only
node .agents/skills/verify/scripts/control-cache-s3.mjs run-action \
  --run-dir "$RUN_DIR" \
  --entry <restore|save|restore-only|save-only> \
  --input "key=<primary-key>" \
  --input "path=<newline-or-single-path>" \
  [--input "restore-keys=<fallback-prefix>"] \
  [--input "fail-on-cache-miss=true"] \
  [--input "lookup-only=true"] \
  [--reset-state] \
  [--no-s3] \
  [--allow-failure] \
  [--path-override "$CUSTOM_PATH"] \
  [--evidence-file "$EVIDENCE_DIR/<step>.json"]

# Inspect stored S3 objects in the local S3 server
node .agents/skills/verify/scripts/control-cache-s3.mjs list-objects \
  --run-dir "$RUN_DIR" \
  [--prefix "<prefix>"] \
  [--evidence-file "$EVIDENCE_DIR/s3-objects.json"]
```

How `run-action` maps the GitHub Actions runtime contract:
- `--input "<name>=<value>"` sets `INPUT_<UPPERCASE_NAME>` (preserving hyphens, e.g. `INPUT_RESTORE-KEYS`, `INPUT_FAIL-ON-CACHE-MISS`), matching `@actions/core.getInput()`.
- `GITHUB_STATE` is persisted across `restore` -> `save` steps inside `$RUN_DIR/github_state.txt` and re-injected as `STATE_<key>` (`STATE_CACHE_KEY`, `STATE_CACHE_RESULT`) for post steps. Pass `--reset-state` to start a fresh workflow job context.
- `GITHUB_OUTPUT` is captured per step from `$RUN_DIR/github_output.txt` and returned in the JSON output (`outputs["cache-hit"]`, `outputs["cache-primary-key"]`, `outputs["cache-matched-key"]`).

## Evidence

Store all proof artifacts in `$EVIDENCE_DIR` (`/tmp/cache-s3-evidence-$RUN_ID`), separate from `$RUN_DIR`, so proof survives cleanup.

Proof standards:
- Exercise the real compiled `dist/*/index.js` bundles, never internal TypeScript modules or unit-test mocks.
- Capture both the action step result (`--evidence-file "$EVIDENCE_DIR/<step>.json"`, containing `exitCode`, `inputs`, `outputs`, `states`, `stdout`, `stderr`) and the resulting side effects:
  1. S3 bucket state via `list-objects --evidence-file "$EVIDENCE_DIR/s3-objects.json"` showing the stored object key (`cache/<owner>/<repo>/<sha256-version>/<key>`), non-zero byte size, and ETag.
  2. Filesystem verification showing that deleting the target directory and running `restore` / `restore-only` recreates the exact files, content, and symlinks on disk.

## Cleanup

Tear down the S3 server process and remove the scratch run directory (`$RUN_DIR`) without touching `$EVIDENCE_DIR`:

```bash
node .agents/skills/verify/scripts/control-cache-s3.mjs cleanup --run-dir "$RUN_DIR"
```

- `cleanup` reads `$RUN_DIR/s3-server.pid`, sends `SIGTERM` to that exact PID (never killing by process name), and removes `$RUN_DIR`.
- Always run `cleanup` after failed iterations as well so broken runs do not leave orphan processes or temp directories.
- After `cleanup`, verify that `$EVIDENCE_DIR` still contains all captured JSON and file proof artifacts.

## Helpers

- [`.agents/skills/verify/scripts/control-cache-s3.mjs`](./scripts/control-cache-s3.mjs): Zero-dependency Node.js CLI providing the local path-style S3 server (`ListObjectsV2`, `GetObject`, `PutObject`, `CreateMultipartUpload`, `UploadPart`, `CompleteMultipartUpload`, `AbortMultipartUpload`) and the GitHub Actions step driver (`start-s3`, `stop-s3`, `doctor`, `run-action`, `list-objects`, `cleanup`).
