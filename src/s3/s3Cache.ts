import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as glob from "@actions/glob";
import * as io from "@actions/io";
import {
    GetObjectCommand,
    ListObjectsV2Command,
    S3Client
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";

const DEFAULT_QUEUE_SIZE = 4;
const DEFAULT_PART_SIZE = 32 * 1024 * 1024; // 32 MiB
const MIN_UPLOAD_PART_SIZE = 5 * 1024 * 1024; // 5 MiB (S3 / @aws-sdk/lib-storage minimum)
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 2_147_483_647; // 32-bit signed int max for Node's setTimeout
const MAX_DOWNLOAD_RETRIES = 3;

export type S3TuningConfig = {
    prefix: string;
    uploadQueueSize: number;
    uploadPartSize: number;
    downloadQueueSize: number;
    downloadPartSize: number;
    downloadTimeoutMs: number;
};

export type ByteRange = {
    index: number;
    start: number;
    end: number;
};

export function unsetAmbientAwsCredentials(env: NodeJS.ProcessEnv): void {
    if (env["CACHE_S3_UNSET_AWS_CREDENTIALS"] === "true") {
        delete env["AWS_ACCESS_KEY_ID"];
        delete env["AWS_SECRET_ACCESS_KEY"];
        delete env["AWS_SESSION_TOKEN"];
    }
}

export class DownloadProgress {
    readonly totalBytes: number;
    private transferred = 0;
    private startTime = Date.now();
    private timer: ReturnType<typeof setInterval> | undefined;
    private lastDisplayedBytes = -1;

    constructor(totalBytes: number) {
        this.totalBytes = totalBytes;
    }

    addBytes(bytes: number): void {
        if (bytes > 0) {
            this.transferred += bytes;
        }
    }

    start(intervalMs = 1000): void {
        this.startTime = Date.now();
        this.stopTimer();
        this.timer = setInterval(() => this.display(), intervalMs);
        this.timer.unref?.();
    }

    display(): void {
        const elapsedSeconds = Math.max(
            (Date.now() - this.startTime) / 1000,
            0.001
        );
        const speedMBs = (
            this.transferred /
            (1024 * 1024) /
            elapsedSeconds
        ).toFixed(1);
        const pct =
            this.totalBytes > 0
                ? Math.min(
                      100,
                      (this.transferred / this.totalBytes) * 100
                  ).toFixed(1)
                : "0.0";
        core.info(
            `Received ${this.transferred} of ${this.totalBytes} (${pct}%), ${speedMBs} MB/s`
        );
        this.lastDisplayedBytes = this.transferred;
    }

    stop(): void {
        this.stopTimer();
        if (
            this.transferred > 0 &&
            this.lastDisplayedBytes !== this.transferred
        ) {
            this.display();
        }
    }

    private stopTimer(): void {
        if (this.timer !== undefined) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }
}

export function parsePositiveInt(
    name: string,
    raw: string | undefined,
    fallback: number,
    minValue = 1,
    maxValue = Number.MAX_SAFE_INTEGER
): number {
    const trimmed = raw?.trim();
    if (!trimmed) {
        return fallback;
    }
    const parsed = Number(trimmed);
    if (
        !/^\d+$/.test(trimmed) ||
        !Number.isSafeInteger(parsed) ||
        parsed < minValue ||
        parsed > maxValue
    ) {
        const requirement =
            maxValue < Number.MAX_SAFE_INTEGER
                ? `an integer between ${minValue} and ${maxValue}`
                : minValue > 1
                  ? `an integer >= ${minValue}`
                  : "a positive integer";
        core.warning(
            `Invalid ${name}="${raw}"; expected ${requirement}. Falling back to ${fallback}.`
        );
        return fallback;
    }
    return parsed;
}

export function computeByteRanges(
    totalSize: number,
    partSize: number
): ByteRange[] {
    if (totalSize <= 0 || partSize <= 0) {
        return [];
    }
    const ranges: ByteRange[] = [];
    let index = 0;
    for (let start = 0; start < totalSize; start += partSize) {
        const end = Math.min(start + partSize - 1, totalSize - 1);
        ranges.push({ index, start, end });
        index++;
    }
    return ranges;
}

const bucketName = process.env["CACHE_S3_BUCKET"];
if (bucketName) {
    unsetAmbientAwsCredentials(process.env);
}

const region = process.env["AWS_REGION"] || process.env["AWS_DEFAULT_REGION"];
const endpoint = process.env["CACHE_S3_ENDPOINT"];
const forcePathStyle =
    (process.env["CACHE_S3_FORCE_PATH_STYLE"] ||
        process.env["AWS_S3_FORCE_PATH_STYLE"]) === "true";

const tuningConfig: S3TuningConfig = {
    prefix: (process.env["CACHE_S3_PREFIX"] ?? "")
        .trim()
        .replace(/^\/+|\/+$/g, ""),
    uploadQueueSize: parsePositiveInt(
        "CACHE_S3_UPLOAD_QUEUE_SIZE",
        process.env["CACHE_S3_UPLOAD_QUEUE_SIZE"],
        DEFAULT_QUEUE_SIZE
    ),
    uploadPartSize: parsePositiveInt(
        "CACHE_S3_UPLOAD_PART_SIZE",
        process.env["CACHE_S3_UPLOAD_PART_SIZE"],
        DEFAULT_PART_SIZE,
        MIN_UPLOAD_PART_SIZE
    ),
    downloadQueueSize: parsePositiveInt(
        "CACHE_S3_DOWNLOAD_QUEUE_SIZE",
        process.env["CACHE_S3_DOWNLOAD_QUEUE_SIZE"],
        DEFAULT_QUEUE_SIZE
    ),
    downloadPartSize: parsePositiveInt(
        "CACHE_S3_DOWNLOAD_PART_SIZE",
        process.env["CACHE_S3_DOWNLOAD_PART_SIZE"],
        DEFAULT_PART_SIZE
    ),
    downloadTimeoutMs: parsePositiveInt(
        "CACHE_S3_DOWNLOAD_TIMEOUT_MS",
        process.env["CACHE_S3_DOWNLOAD_TIMEOUT_MS"],
        DEFAULT_DOWNLOAD_TIMEOUT_MS,
        1,
        MAX_TIMEOUT_MS
    )
};

const s3Client = new S3Client({
    region,
    ...(endpoint ? { endpoint } : {}),
    forcePathStyle
});

export function isS3Available(): boolean {
    return !!bucketName;
}

type Compression = "zstd" | "gzip";

async function getCompression(): Promise<Compression> {
    try {
        await io.which("zstd", true);
        return "zstd";
    } catch {
        return "gzip";
    }
}

function checkPaths(paths: string[]): void {
    if (!paths || paths.length === 0) {
        throw new Error(
            "Path Validation Error: At least one directory or file path is required"
        );
    }
}

function checkKey(key: string): void {
    if (!key) {
        throw new Error("Key Validation Error: Key cannot be empty.");
    }
    if (key.length > 512) {
        throw new Error(
            `Key Validation Error: ${key} cannot be larger than 512 characters.`
        );
    }
    const regex = /^[^,]*$/;
    if (!regex.test(key)) {
        throw new Error(`Key Validation Error: ${key} cannot contain commas.`);
    }
}

function cacheVersion(
    paths: string[],
    compression: Compression,
    enableCrossOsArchive = false
): string {
    const components = [...paths, compression];
    if (process.platform === "win32" && !enableCrossOsArchive) {
        components.push("windows-only");
    }
    components.push("1.1");
    return crypto
        .createHash("sha256")
        .update(components.join("|"))
        .digest("hex");
}

function s3Prefix(scope: string, version: string): string {
    const root =
        tuningConfig.prefix || `cache/${process.env["GITHUB_REPOSITORY"]}`;
    return `${root}/${scope}/${version}/`;
}

// A malformed or missing event payload is not an error here; it only means the
// default branch is unknown, so CACHE_S3_DEFAULT_BRANCH is consulted instead.
function readDefaultBranch(env: NodeJS.ProcessEnv): string | undefined {
    const eventPath = env["GITHUB_EVENT_PATH"];
    if (eventPath) {
        try {
            const payload = JSON.parse(fs.readFileSync(eventPath, "utf8")) as {
                repository?: { default_branch?: unknown };
            } | null;
            const branch = payload?.repository?.default_branch;
            if (typeof branch === "string" && branch.trim()) {
                return branch.trim();
            }
        } catch (err) {
            core.debug(
                `Failed to read default branch from ${eventPath}: ${(err as Error).message}`
            );
        }
    }
    return env["CACHE_S3_DEFAULT_BRANCH"]?.trim() || undefined;
}

// Refs to search, in priority order, mirroring actions/cache scoping: the
// current ref, then the PR base branch, then the default branch.
function cacheScopes(
    ref: string,
    baseRef: string | undefined,
    defaultBranch: string | undefined
): string[] {
    const scopes = [ref];
    if (baseRef) {
        scopes.push(`refs/heads/${baseRef}`);
    }
    if (defaultBranch) {
        scopes.push(`refs/heads/${defaultBranch}`);
    }
    return [...new Set(scopes)];
}

function resolveScopes(): string[] {
    const env = process.env;
    const ref = env["GITHUB_REF"]?.trim();
    if (!ref) {
        throw new Error("GITHUB_REF is not set");
    }
    return cacheScopes(
        ref,
        env["GITHUB_BASE_REF"]?.trim(),
        readDefaultBranch(env)
    );
}

type CacheEntry = { s3Key: string; matchedKey: string; size?: number };

// Within one scope, keys are tried in order and the newest object matching a
// key prefix wins.
async function findInScope(
    prefix: string,
    keys: string[]
): Promise<CacheEntry | undefined> {
    for (const key of keys) {
        try {
            const { Contents = [] } = await s3Client.send(
                new ListObjectsV2Command({
                    Bucket: bucketName,
                    Prefix: `${prefix}${key}`
                })
            );
            if (Contents.length > 0) {
                const latest = Contents.sort(
                    (a, b) => Number(b.LastModified) - Number(a.LastModified)
                )[0];
                return {
                    s3Key: latest.Key!,
                    matchedKey: latest.Key!.slice(prefix.length),
                    size: latest.Size
                };
            }
        } catch (err) {
            core.warning(
                `Failed to list cache for key "${key}": ${(err as Error).message}`
            );
        }
    }
    return undefined;
}

async function createTempDir(): Promise<string> {
    return fs.promises.mkdtemp(path.join(os.tmpdir(), "cache-s3-"));
}

async function resolvePaths(patterns: string[]): Promise<string[]> {
    // implicitDescendants expands a directory into every descendant path. tar
    // then re-recurses each of those directories, duplicating subtrees, and a
    // symlink farm (pnpm) is both collected twice and materialized as real
    // directories on extract.
    const globber = await glob.create(patterns.join("\n"), {
        implicitDescendants: false
    });
    return globber.glob();
}

async function zstdDecompressProgram(): Promise<string> {
    // zstd is sometimes installed without the unzstd symlink. "zstd -d" is an
    // equivalent filter, and the extra -d that GNU tar appends when extracting
    // is harmless.
    try {
        await io.which("unzstd", true);
        return "unzstd";
    } catch {
        return "zstd -d";
    }
}

async function createArchive(
    archivePath: string,
    resolvedPaths: string[],
    compression: Compression
): Promise<void> {
    const manifestPath = `${archivePath}.manifest`;
    await fs.promises.writeFile(manifestPath, resolvedPaths.join("\n") + "\n");
    try {
        if (compression === "zstd") {
            await exec.exec("tar", [
                "--use-compress-program",
                "zstd -T0",
                "-cf",
                archivePath,
                "-T",
                manifestPath
            ]);
        } else {
            await exec.exec("tar", ["-czf", archivePath, "-T", manifestPath]);
        }
    } finally {
        await fs.promises.unlink(manifestPath).catch(() => undefined);
    }
}

async function extractArchive(
    archivePath: string,
    compression: Compression
): Promise<void> {
    if (compression === "zstd") {
        await exec.exec("tar", [
            "--use-compress-program",
            await zstdDecompressProgram(),
            "-xf",
            archivePath,
            "-C",
            "/"
        ]);
    } else {
        await exec.exec("tar", ["-xzf", archivePath, "-C", "/"]);
    }
}

async function listArchive(
    archivePath: string,
    compression: Compression
): Promise<void> {
    try {
        if (compression === "zstd") {
            await exec.exec("tar", [
                "--use-compress-program",
                await zstdDecompressProgram(),
                "-tf",
                archivePath
            ]);
        } else {
            await exec.exec("tar", ["-tzf", archivePath]);
        }
    } catch (err) {
        core.debug(`Failed to list archive: ${(err as Error).message}`);
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function downloadSingleWithRetry(
    s3Key: string,
    archivePath: string,
    expectedSize?: number
): Promise<number> {
    for (let attempt = 1; attempt <= MAX_DOWNLOAD_RETRIES; attempt++) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(
                () =>
                    controller.abort(
                        new Error(
                            `Download timed out after ${tuningConfig.downloadTimeoutMs}ms`
                        )
                    ),
                tuningConfig.downloadTimeoutMs
            );
            try {
                const { Body, ContentLength } = await s3Client.send(
                    new GetObjectCommand({ Bucket: bucketName, Key: s3Key }),
                    { abortSignal: controller.signal }
                );
                if (!Body) {
                    throw new Error("Empty response body from S3");
                }
                const progress = new DownloadProgress(
                    expectedSize ?? ContentLength ?? 0
                );
                progress.start();
                try {
                    const progressStream = new Transform({
                        transform(chunk, _encoding, callback) {
                            progress.addBytes(Buffer.byteLength(chunk));
                            callback(null, chunk);
                        }
                    });
                    await pipeline(
                        Body as Readable,
                        progressStream,
                        fs.createWriteStream(archivePath),
                        { signal: controller.signal }
                    );
                } finally {
                    progress.stop();
                }

                const downloadedSize = fs.statSync(archivePath).size;
                if (downloadedSize <= 0) {
                    throw new Error(
                        "Downloaded cache archive is empty (0 bytes)"
                    );
                }
                const targetSize = expectedSize ?? ContentLength;
                if (targetSize !== undefined && downloadedSize !== targetSize) {
                    throw new Error(
                        `Downloaded size mismatch: expected ${targetSize} bytes, got ${downloadedSize} bytes`
                    );
                }
                return downloadedSize;
            } finally {
                clearTimeout(timeoutId);
            }
        } catch (err) {
            if (attempt >= MAX_DOWNLOAD_RETRIES) {
                throw err;
            }
            await sleep(200 * attempt);
        }
    }
    throw new Error("Download failed after retries");
}

async function downloadRangeWithRetry(
    s3Key: string,
    range: ByteRange,
    fileHandle: fs.promises.FileHandle
): Promise<void> {
    const expectedLength = range.end - range.start + 1;
    const expectedContentRangePrefix = `bytes ${range.start}-${range.end}/`;
    for (let attempt = 1; attempt <= MAX_DOWNLOAD_RETRIES; attempt++) {
        try {
            const controller = new AbortController();
            let bodyStream: Readable | undefined;
            let consumingStream = false;
            const abortReason = (): Error =>
                controller.signal.reason instanceof Error
                    ? controller.signal.reason
                    : new Error(
                          `Download timed out after ${tuningConfig.downloadTimeoutMs}ms`
                      );
            const safelyDestroyStream = (
                stream: Readable | undefined,
                err?: Error
            ): void => {
                if (!stream || typeof stream.destroy !== "function") {
                    return;
                }
                if (!consumingStream) {
                    stream.on?.("error", () => undefined);
                    stream.destroy();
                } else {
                    stream.destroy(err);
                }
            };
            const onAbort = (): void => {
                safelyDestroyStream(bodyStream, abortReason());
            };
            controller.signal.addEventListener("abort", onAbort, {
                once: true
            });
            const timeoutId = setTimeout(
                () =>
                    controller.abort(
                        new Error(
                            `Download timed out after ${tuningConfig.downloadTimeoutMs}ms`
                        )
                    ),
                tuningConfig.downloadTimeoutMs
            );
            try {
                const { Body, ContentRange } = await s3Client.send(
                    new GetObjectCommand({
                        Bucket: bucketName,
                        Key: s3Key,
                        Range: `bytes=${range.start}-${range.end}`
                    }),
                    { abortSignal: controller.signal }
                );
                if (!Body) {
                    throw new Error(
                        `Empty response body for range ${range.start}-${range.end}`
                    );
                }
                bodyStream = Body as Readable;
                if (controller.signal.aborted) {
                    safelyDestroyStream(bodyStream);
                    throw abortReason();
                }
                if (
                    ContentRange !== undefined &&
                    !ContentRange.startsWith(expectedContentRangePrefix)
                ) {
                    throw new Error(
                        `Range ${range.start}-${range.end} Content-Range mismatch: got "${ContentRange}"`
                    );
                }
                let bytesWritten = 0;
                consumingStream = true;
                try {
                    for await (const chunk of bodyStream) {
                        if (controller.signal.aborted) {
                            throw abortReason();
                        }
                        const buf = Buffer.isBuffer(chunk)
                            ? chunk
                            : Buffer.from(chunk);
                        if (bytesWritten + buf.length > expectedLength) {
                            throw new Error(
                                `Range ${range.start}-${range.end} size mismatch: expected ${expectedLength} bytes, received > ${expectedLength} bytes`
                            );
                        }
                        let chunkOffset = 0;
                        while (chunkOffset < buf.length) {
                            const { bytesWritten: written } =
                                await fileHandle.write(
                                    buf,
                                    chunkOffset,
                                    buf.length - chunkOffset,
                                    range.start + bytesWritten
                                );
                            bytesWritten += written;
                            chunkOffset += written;
                        }
                    }
                } finally {
                    consumingStream = false;
                }
                if (controller.signal.aborted) {
                    throw abortReason();
                }
                if (bytesWritten !== expectedLength) {
                    throw new Error(
                        `Range ${range.start}-${range.end} size mismatch: expected ${expectedLength} bytes, got ${bytesWritten} bytes`
                    );
                }
                return;
            } finally {
                clearTimeout(timeoutId);
                controller.signal.removeEventListener("abort", onAbort);
                if (bodyStream && !bodyStream.destroyed) {
                    safelyDestroyStream(bodyStream);
                }
            }
        } catch (err) {
            if (attempt >= MAX_DOWNLOAD_RETRIES) {
                throw err;
            }
            await sleep(200 * attempt);
        }
    }
}

async function downloadConcurrentRanges(
    s3Key: string,
    archivePath: string,
    totalSize: number
): Promise<number> {
    const ranges = computeByteRanges(totalSize, tuningConfig.downloadPartSize);
    const fileHandle = await fs.promises.open(archivePath, "w+");
    const progress = new DownloadProgress(totalSize);
    progress.start();
    try {
        let nextIndex = 0;
        const workerCount = Math.min(
            tuningConfig.downloadQueueSize,
            ranges.length
        );
        const workers = Array.from({ length: workerCount }, async () => {
            while (nextIndex < ranges.length) {
                const range = ranges[nextIndex++];
                await downloadRangeWithRetry(s3Key, range, fileHandle);
                progress.addBytes(range.end - range.start + 1);
            }
        });
        await Promise.all(workers);
    } finally {
        progress.stop();
        await fileHandle.close();
    }

    const size = fs.statSync(archivePath).size;
    if (size <= 0 || size !== totalSize) {
        throw new Error(
            `Downloaded size mismatch: expected ${totalSize} bytes, got ${size} bytes`
        );
    }
    return size;
}

export async function restoreCache(
    paths: string[],
    primaryKey: string,
    restoreKeys: string[] = [],
    options?: { lookupOnly?: boolean },
    enableCrossOsArchive = false
): Promise<string | undefined> {
    if (!bucketName) {
        throw new Error("CACHE_S3_BUCKET is not set");
    }

    const scopes = resolveScopes();

    checkPaths(paths);
    const keys = [primaryKey, ...restoreKeys];
    if (keys.length > 10) {
        throw new Error(
            "Key Validation Error: Keys are limited to a maximum of 10."
        );
    }
    for (const key of keys) {
        checkKey(key);
    }
    core.debug(`Resolved Keys: ${JSON.stringify(keys)}`);

    const compression = await getCompression();
    const version = cacheVersion(paths, compression, enableCrossOsArchive);

    let entry: CacheEntry | undefined;
    for (const scope of scopes) {
        entry = await findInScope(s3Prefix(scope, version), keys);
        if (entry) {
            core.debug(`Cache found in scope ${scope}`);
            break;
        }
    }

    if (!entry) {
        return undefined;
    }
    const { s3Key, matchedKey, size: objectSize } = entry;

    if (options?.lookupOnly) {
        return matchedKey;
    }

    const tmpDir = await createTempDir();
    const ext = compression === "zstd" ? "tar.zst" : "tar.gz";
    const archivePath = path.join(tmpDir, `cache.${ext}`);
    core.debug(`Archive Path: ${archivePath}`);

    try {
        if (objectSize === 0) {
            throw new Error("Cached object is empty (0 bytes)");
        }

        const size =
            objectSize !== undefined &&
            objectSize > tuningConfig.downloadPartSize
                ? await downloadConcurrentRanges(s3Key, archivePath, objectSize)
                : await downloadSingleWithRetry(s3Key, archivePath, objectSize);

        core.info(
            `Cache Size: ~${Math.round(size / (1024 * 1024))} MB (${size} B)`
        );

        if (core.isDebug()) {
            await listArchive(archivePath, compression);
        }

        await extractArchive(archivePath, compression);
        core.info("Cache restored successfully");
        return matchedKey;
    } catch (err) {
        core.warning(`Failed to restore cache: ${(err as Error).message}`);
        return undefined;
    } finally {
        await fs.promises
            .rm(tmpDir, { recursive: true, force: true })
            .catch(() => undefined);
    }
}

export async function saveCache(
    paths: string[],
    key: string,
    enableCrossOsArchive = false
): Promise<void> {
    if (!bucketName) {
        throw new Error("CACHE_S3_BUCKET is not set");
    }

    const [scope] = resolveScopes();

    checkPaths(paths);
    checkKey(key);

    const compression = await getCompression();
    const version = cacheVersion(paths, compression, enableCrossOsArchive);
    const s3Key = `${s3Prefix(scope, version)}${key}`;

    const resolved = await resolvePaths(paths);
    if (resolved.length === 0) {
        throw new Error(
            `Path Validation Error: Path(s) ${paths.join(", ")} do not exist.`
        );
    }
    core.debug(`Cache Paths: ${JSON.stringify(resolved)}`);

    const tmpDir = await createTempDir();
    const ext = compression === "zstd" ? "tar.zst" : "tar.gz";
    const archivePath = path.join(tmpDir, `cache.${ext}`);
    core.debug(`Archive Path: ${archivePath}`);

    try {
        await createArchive(archivePath, resolved, compression);

        if (core.isDebug()) {
            await listArchive(archivePath, compression);
        }

        const size = fs.statSync(archivePath).size;
        core.info(
            `Cache Size: ~${Math.round(size / (1024 * 1024))} MB (${size} B)`
        );
        core.info(`Uploading cache to s3://${bucketName}/${s3Key}`);

        const totalParts = Math.max(
            1,
            Math.ceil(size / tuningConfig.uploadPartSize)
        );
        const upload = new Upload({
            client: s3Client,
            params: {
                Bucket: bucketName,
                Key: s3Key,
                Body: fs.createReadStream(archivePath)
            },
            partSize: tuningConfig.uploadPartSize,
            queueSize: tuningConfig.uploadQueueSize
        });
        upload.on("httpUploadProgress", progress => {
            if (progress.part !== undefined) {
                core.info(`Uploaded part ${progress.part}/${totalParts}`);
            }
        });
        await upload.done();
        core.info("Cache saved successfully");
    } finally {
        await fs.promises
            .rm(tmpDir, { recursive: true, force: true })
            .catch(() => undefined);
    }
}
