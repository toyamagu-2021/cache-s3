# Releases

The major version of this fork tracks upstream `actions/cache`, so `v5` here and `v5`
upstream run on the same Node runtime and talk to the same cache service APIs. Minor and
patch numbers are the fork's own sequence and do not correspond to any upstream release.
See the [upstream releases](https://github.com/actions/cache/releases) for the history of
the code this fork builds on.

## How to prepare a release

1. Switch to a new branch from `main`.
1. Run `pnpm test` to ensure all tests are passing.
1. Update the version in [`package.json`](package.json).
1. Run `pnpm build` to update the compiled files in `dist/`.
1. Update this [`RELEASES.md`](RELEASES.md) with the new version and changes in the `## Changelog` section.
1. Run `licensed cache` to update the license report.
1. Run `licensed status` and resolve any warnings by updating the [`.licensed.yml`](.licensed.yml) file with the exceptions.
1. Commit your changes, push the branch, open a pull request against `main`, and merge it.
1. Draft a new release at https://github.com/toyamagu-2021/cache-s3/releases using the same
   version number used in `package.json`.
    1. Create the tag from `main`.
    1. Write the release notes to match the changes in `RELEASES.md`.
    1. Toggle the set as the latest release option.
    1. Publish the release.
1. Move the major tag so that `@v<major>` resolves to the new release:

    ```bash
    git fetch origin --tags
    git tag -f v5 v5.1.0
    git push -f origin v5
    ```

## Changelog

### 5.1.0

- S3 cache backend: when `CACHE_S3_BUCKET` is set, cache objects are stored in and
  restored from S3 instead of the GitHub cache service. Without it, the action falls
  back to the GitHub cache service.
- `zstd` (or `gzip` when `zstd` is unavailable) is driven as a single streaming `tar`
  pipeline, so the archive is written and read exactly once.
- Cached directories are archived as-is instead of being expanded into their descendant
  paths.
- pnpm as the package manager, with `dist/` verified against a rebuild on every pull
  request.
