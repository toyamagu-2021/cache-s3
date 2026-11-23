# Compression and archive fidelity (`zstd` vs `gzip` and symlinks)

`s3Cache.ts` selects `zstd` when `zstd` is on `PATH` and falls back to `gzip` otherwise, partitioning the S3 prefix version hash by compression method (`sha256([...paths, compression, "1.1"].join("|"))`). It also passes `implicitDescendants: false` to `@actions/glob` so symlink farms (such as `pnpm` `node_modules`) are archived and extracted intact as symlinks rather than duplicated or materialized as real directories.

## Sub-features

- `archive-symlinks` preserves relative and directory symlinks inside a cached directory across `save-only` and `restore-only` without materializing them into duplicate real directories.
- `compression-gzip-fallback` uses `tar -czf` / `tar -xzf` when `zstd` is absent from `PATH` and stores the object under the `gzip` version hash.
- `compression-version-isolation` isolates `zstd` caches from `gzip` caches under distinct S3 version prefixes even when `path` and `key` are identical.

## How to get to it (user POV)

- Run `toyamagu-2021/cache-s3` on a runner with or without `zstd` installed on `PATH`, caching a directory that contains files and symlinks.

## Driving it with control-cache-s3

Preconditions:

- `node .agents/skills/verify/scripts/control-cache-s3.mjs doctor --run-dir "$RUN_DIR"` reports `"healthy": true`.

- **Create a directory tree with a symlink farm.** Create real files and symlinks inside `$RUN_DIR/workspace/pnpm-store`. Run:
  `mkdir -p "$RUN_DIR/workspace/pnpm-store/.pnpm/pkg-a/node_modules/pkg-a" "$RUN_DIR/workspace/pnpm-store/node_modules"`
  `printf "export const a = 1;\n" > "$RUN_DIR/workspace/pnpm-store/.pnpm/pkg-a/node_modules/pkg-a/index.js"`
  `ln -s ../.pnpm/pkg-a/node_modules/pkg-a "$RUN_DIR/workspace/pnpm-store/node_modules/pkg-a"`.
- **Save and restore the symlink tree.** Save with `save-only`, delete `$RUN_DIR/workspace/pnpm-store`, and restore with `restore-only`. Run:
  `node .agents/skills/verify/scripts/control-cache-s3.mjs run-action --run-dir "$RUN_DIR" --reset-state --entry save-only --input "key=symlink-test-1" --input "path=$RUN_DIR/workspace/pnpm-store" --evidence-file "$EVIDENCE_DIR/archive-1-save.json"`
  `rm -rf "$RUN_DIR/workspace/pnpm-store"`
  `node .agents/skills/verify/scripts/control-cache-s3.mjs run-action --run-dir "$RUN_DIR" --reset-state --entry restore-only --input "key=symlink-test-1" --input "path=$RUN_DIR/workspace/pnpm-store" --evidence-file "$EVIDENCE_DIR/archive-2-restore.json"`.
  Exit code is `0`, `outputs["cache-hit"]` is `"true"`, `test -L "$RUN_DIR/workspace/pnpm-store/node_modules/pkg-a"` exits `0` (still a symbolic link, not a materialized directory), and `readlink "$RUN_DIR/workspace/pnpm-store/node_modules/pkg-a"` outputs `../.pnpm/pkg-a/node_modules/pkg-a`.

## Gotchas

- If `zstd` is installed on a runner that previously used `gzip` (or vice versa), existing S3 caches become unreachable because the compression name (`"zstd"` vs `"gzip"`) is hashed into the S3 prefix version.
- When `zstd` is installed without the `unzstd` symlink, `s3Cache.ts` automatically falls back to `--use-compress-program "zstd -d"`.
