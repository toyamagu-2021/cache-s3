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

export type S3TuningConfig = {
    prefix: string;
    uploadQueueSize: number;
    uploadPartSize: number;
    downloadQueueSize: number;
    downloadPartSize: number;
};

export function parsePositiveInt(
    name: string,
    raw: string | undefined,
    fallback: number,
    minValue = 1
): number {
    const trimmed = raw?.trim();
    if (!trimmed) {
        return fallback;
    }
    const parsed = Number(trimmed);
    if (
        !/^\d+$/.test(trimmed) ||
        !Number.isSafeInteger(parsed) ||
        parsed < minValue
    ) {
        const requirement =
            minValue > 1
                ? `an integer >= ${minValue}`
                : "a positive integer";
        core.warning(
            `Invalid ${name}="${raw}"; expected ${requirement}. Falling back to ${fallback}.`
        );
        return fallback;
    }
    return parsed;
}

const bucketName = process.env["CACHE_S3_BUCKET"];
const region = process.env["AWS_REGION"] || process.env["AWS_DEFAULT_REGION"];
const endpoint = process.env["CACHE_S3_ENDPOINT"];
const forcePathStyle = process.env["CACHE_S3_FORCE_PATH_STYLE"] === "true";

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
        // Download directly via SDK without presigned URL
        const { Body } = await s3Client.send(
            new GetObjectCommand({ Bucket: bucketName, Key: s3Key })
        );
        if (!Body) {
            throw new Error("Empty response body from S3");
        }
        await pipeline(Body as Readable, fs.createWriteStream(archivePath));

        const size = fs.statSync(archivePath).size;
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
