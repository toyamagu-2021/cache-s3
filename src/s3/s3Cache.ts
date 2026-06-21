import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as glob from "@actions/glob";
import * as io from "@actions/io";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";

import {
    GetObjectCommand,
    ListObjectsV2Command,
    S3Client
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";

const bucketName = process.env["CACHE_S3_BUCKET"];
const region = process.env["AWS_REGION"] || process.env["AWS_DEFAULT_REGION"];
const endpoint = process.env["CACHE_S3_ENDPOINT"];
const forcePathStyle = process.env["CACHE_S3_FORCE_PATH_STYLE"] === "true";

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

function cacheVersion(paths: string[], compression: Compression): string {
    return crypto
        .createHash("sha256")
        .update([...paths, compression, "1.0"].join("|"))
        .digest("hex");
}

function s3Prefix(paths: string[], compression: Compression): string {
    const repo = process.env["GITHUB_REPOSITORY"];
    const version = cacheVersion(paths, compression);
    return `cache/${repo}/${version}/`;
}

async function createTempDir(): Promise<string> {
    return fs.promises.mkdtemp(path.join(os.tmpdir(), "cache-s3-"));
}

async function resolvePaths(patterns: string[]): Promise<string[]> {
    const globber = await glob.create(patterns.join("\n"));
    return globber.glob();
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
            await exec.exec("bash", [
                "-c",
                `tar -cf - -T '${manifestPath}' | zstd -T0 -o '${archivePath}'`
            ]);
        } else {
            await exec.exec("tar", ["-czf", archivePath, `-T`, manifestPath]);
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
        await exec.exec("bash", [
            "-c",
            `zstd -d '${archivePath}' --stdout | tar -xf - -C /`
        ]);
    } else {
        await exec.exec("tar", ["-xzf", archivePath, "-C", "/"]);
    }
}

export async function restoreCache(
    paths: string[],
    primaryKey: string,
    restoreKeys: string[] = []
): Promise<string | undefined> {
    if (!bucketName) {
        throw new Error("CACHE_S3_BUCKET is not set");
    }

    const compression = await getCompression();
    const prefix = s3Prefix(paths, compression);
    const keys = [primaryKey, ...restoreKeys];

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

export async function saveCache(paths: string[], key: string): Promise<void> {
    if (!bucketName) {
        throw new Error("CACHE_S3_BUCKET is not set");
    }

    const compression = await getCompression();
    const prefix = s3Prefix(paths, compression);
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
            partSize: 32 * 1024 * 1024,
            queueSize: 4
        });
        await upload.done();
        core.info("Cache saved successfully");
    } finally {
        await fs.promises
            .rm(tmpDir, { recursive: true, force: true })
            .catch(() => undefined);
    }
}
