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
import { Readable } from "stream";
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

function s3Prefix(
    paths: string[],
    compression: Compression,
    enableCrossOsArchive = false
): string {
    const version = cacheVersion(paths, compression, enableCrossOsArchive);
    if (tuningConfig.prefix) {
        return `${tuningConfig.prefix}/${version}/`;
    }
    const repo = process.env["GITHUB_REPOSITORY"];
    return `cache/${repo}/${version}/`;
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
                await pipeline(
                    Body as Readable,
                    fs.createWriteStream(archivePath),
                    { signal: controller.signal }
                );

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
            }
        });
        await Promise.all(workers);
    } finally {
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

    const compression = await getCompression();
    const prefix = s3Prefix(paths, compression, enableCrossOsArchive);

    let matchedKey: string | undefined;
    let s3Key: string | undefined;
    let objectSize: number | undefined;

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
                s3Key = latest.Key!;
                matchedKey = s3Key.slice(prefix.length);
                objectSize = latest.Size;
                break;
            }
        } catch (err) {
            core.warning(
                `Failed to list cache for key "${key}": ${(err as Error).message}`
            );
        }
    }

    if (!s3Key || !matchedKey) {
        return undefined;
    }

    if (options?.lookupOnly) {
        return matchedKey;
    }

    const tmpDir = await createTempDir();
    const ext = compression === "zstd" ? "tar.zst" : "tar.gz";
    const archivePath = path.join(tmpDir, `cache.${ext}`);

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

    checkPaths(paths);
    checkKey(key);

    const compression = await getCompression();
    const prefix = s3Prefix(paths, compression, enableCrossOsArchive);
    const s3Key = `${prefix}${key}`;

    const resolved = await resolvePaths(paths);
    if (resolved.length === 0) {
        throw new Error(
            `Path Validation Error: Path(s) ${paths.join(", ")} do not exist.`
        );
    }

    const tmpDir = await createTempDir();
    const ext = compression === "zstd" ? "tar.zst" : "tar.gz";
    const archivePath = path.join(tmpDir, `cache.${ext}`);

    try {
        await createArchive(archivePath, resolved, compression);

        const size = fs.statSync(archivePath).size;
        core.info(
            `Cache Size: ~${Math.round(size / (1024 * 1024))} MB (${size} B)`
        );
        core.info(`Uploading cache to s3://${bucketName}/${s3Key}`);

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
        await upload.done();
        core.info("Cache saved successfully");
    } finally {
        await fs.promises
            .rm(tmpDir, { recursive: true, force: true })
            .catch(() => undefined);
    }
}
