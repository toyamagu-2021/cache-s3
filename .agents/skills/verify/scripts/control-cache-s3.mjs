#!/usr/bin/env node
/**
 * Local S3-compatible server and GitHub Actions runner harness for cache-s3 verification.
 *
 * Usage:
 *   control-cache-s3 s3-server --port <port> --storage-dir <dir> [--pid-file <file>]
 *   control-cache-s3 start-s3 --run-dir <dir> [--port <port>]
 *   control-cache-s3 stop-s3 --run-dir <dir>
 *   control-cache-s3 doctor --run-dir <dir>
 *   control-cache-s3 run-action --run-dir <dir> --entry <restore|save|restore-only|save-only> [options]
 *   control-cache-s3 list-objects --run-dir <dir> [--bucket <bucket>] [--prefix <prefix>]
 *   control-cache-s3 cleanup --run-dir <dir>
 */

import { spawn } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../../../..");

function parseArgs(argv) {
    const command = argv[0];
    const flags = {};
    const inputs = {};
    const envs = {};
    for (let i = 1; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--input") {
            const val = argv[++i] || "";
            const eq = val.indexOf("=");
            if (eq !== -1) {
                inputs[val.slice(0, eq)] = val.slice(eq + 1);
            }
        } else if (arg === "--env") {
            const val = argv[++i] || "";
            const eq = val.indexOf("=");
            if (eq !== -1) {
                envs[val.slice(0, eq)] = val.slice(eq + 1);
            }
        } else if (arg.startsWith("--")) {
            const key = arg.slice(2);
            const next = argv[i + 1];
            if (next !== undefined && !next.startsWith("--")) {
                flags[key] = next;
                i++;
            } else {
                flags[key] = "true";
            }
        }
    }
    return { command, flags, inputs, envs };
}

function xmlEscape(str) {
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

function encodeObjectPath(storageDir, bucket, key) {
    const safeBucket = encodeURIComponent(bucket);
    const safeKey = Buffer.from(key, "utf8").toString("base64url");
    return {
        dataPath: path.join(storageDir, "buckets", safeBucket, `${safeKey}.bin`),
        metaPath: path.join(storageDir, "buckets", safeBucket, `${safeKey}.json`)
    };
}

function listBucketObjects(storageDir, bucket, prefix = "") {
    const bucketDir = path.join(storageDir, "buckets", encodeURIComponent(bucket));
    if (!fs.existsSync(bucketDir)) {
        return [];
    }
    const entries = fs.readdirSync(bucketDir).filter(f => f.endsWith(".json"));
    const objects = [];
    for (const entry of entries) {
        try {
            const meta = JSON.parse(
                fs.readFileSync(path.join(bucketDir, entry), "utf8")
            );
            if (!prefix || meta.key.startsWith(prefix)) {
                objects.push(meta);
            }
        } catch {
            // ignore partial metadata
        }
    }
    objects.sort((a, b) => a.key.localeCompare(b.key));
    return objects;
}

async function runS3Server(port, storageDir, pidFile) {
    fs.mkdirSync(path.join(storageDir, "buckets"), { recursive: true });
    fs.mkdirSync(path.join(storageDir, "uploads"), { recursive: true });
    const requestsLogPath = path.join(storageDir, "requests.jsonl");

    function logRequest(entry) {
        fs.appendFileSync(
            requestsLogPath,
            JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + "\n"
        );
    }

    const server = http.createServer((req, res) => {
        const parsedUrl = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
        const pathname = decodeURIComponent(parsedUrl.pathname);

        if (pathname === "/__health") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
                JSON.stringify({
                    ok: true,
                    pid: process.pid,
                    storageDir
                })
            );
            return;
        }

        if (pathname === "/__objects") {
            const bucket = parsedUrl.searchParams.get("bucket") || "verify-bucket";
            const prefix = parsedUrl.searchParams.get("prefix") || "";
            const objects = listBucketObjects(storageDir, bucket, prefix);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ bucket, prefix, objects }, null, 2));
            return;
        }

        // Parse path-style URL: /<bucket> or /<bucket>/<key...>
        const trimmed = pathname.replace(/^\/+/, "");
        const slashIdx = trimmed.indexOf("/");
        const bucket = slashIdx === -1 ? trimmed : trimmed.slice(0, slashIdx);
        const key = slashIdx === -1 ? "" : trimmed.slice(slashIdx + 1);

        const chunks = [];
        req.on("data", chunk => chunks.push(chunk));
        req.on("end", () => {
            const body = Buffer.concat(chunks);
            const query = Object.fromEntries(parsedUrl.searchParams.entries());
            logRequest({
                method: req.method,
                bucket,
                key,
                query,
                range: req.headers.range || null,
                ifNoneMatch: req.headers["if-none-match"] || null,
                size: body.length
            });

            // ListObjectsV2: GET /<bucket>?list-type=2&prefix=...
            if (req.method === "GET" && (!key || "list-type" in query)) {
                const prefix = query.prefix || "";
                const objects = listBucketObjects(storageDir, bucket, prefix);
                const contentsXml = objects
                    .map(
                        obj =>
                            `<Contents>` +
                            `<Key>${xmlEscape(obj.key)}</Key>` +
                            `<LastModified>${xmlEscape(obj.lastModified)}</LastModified>` +
                            `<ETag>&quot;${xmlEscape(obj.etag)}&quot;</ETag>` +
                            `<Size>${obj.size}</Size>` +
                            `<StorageClass>STANDARD</StorageClass>` +
                            `</Contents>`
                    )
                    .join("");
                const xml =
                    `<?xml version="1.0" encoding="UTF-8"?>` +
                    `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
                    `<Name>${xmlEscape(bucket)}</Name>` +
                    `<Prefix>${xmlEscape(prefix)}</Prefix>` +
                    `<KeyCount>${objects.length}</KeyCount>` +
                    `<MaxKeys>1000</MaxKeys>` +
                    `<IsTruncated>false</IsTruncated>` +
                    contentsXml +
                    `</ListBucketResult>`;
                res.writeHead(200, { "content-type": "application/xml" });
                res.end(xml);
                return;
            }

            // CreateMultipartUpload: POST /<bucket>/<key>?uploads
            if (req.method === "POST" && "uploads" in query) {
                const uploadId = crypto.randomUUID();
                const uploadDir = path.join(storageDir, "uploads", uploadId);
                fs.mkdirSync(uploadDir, { recursive: true });
                fs.writeFileSync(
                    path.join(uploadDir, "meta.json"),
                    JSON.stringify({ bucket, key })
                );
                const xml =
                    `<?xml version="1.0" encoding="UTF-8"?>` +
                    `<InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
                    `<Bucket>${xmlEscape(bucket)}</Bucket>` +
                    `<Key>${xmlEscape(key)}</Key>` +
                    `<UploadId>${xmlEscape(uploadId)}</UploadId>` +
                    `</InitiateMultipartUploadResult>`;
                res.writeHead(200, { "content-type": "application/xml" });
                res.end(xml);
                return;
            }

            // UploadPart: PUT /<bucket>/<key>?partNumber=N&uploadId=ID
            if (req.method === "PUT" && query.uploadId && query.partNumber) {
                const uploadDir = path.join(storageDir, "uploads", query.uploadId);
                fs.mkdirSync(uploadDir, { recursive: true });
                const partFile = path.join(
                    uploadDir,
                    `part-${String(query.partNumber).padStart(6, "0")}.bin`
                );
                fs.writeFileSync(partFile, body);
                const etag = crypto.createHash("md5").update(body).digest("hex");
                res.writeHead(200, { ETag: `"${etag}"` });
                res.end();
                return;
            }

            // CompleteMultipartUpload: POST /<bucket>/<key>?uploadId=ID
            if (req.method === "POST" && query.uploadId) {
                const uploadDir = path.join(storageDir, "uploads", query.uploadId);
                const { dataPath, metaPath } = encodeObjectPath(
                    storageDir,
                    bucket,
                    key
                );
                if (
                    req.headers["if-none-match"] === "*" &&
                    fs.existsSync(dataPath) &&
                    fs.existsSync(metaPath)
                ) {
                    fs.rmSync(uploadDir, { recursive: true, force: true });
                    const xml =
                        `<?xml version="1.0" encoding="UTF-8"?>` +
                        `<Error><Code>PreconditionFailed</Code><Message>At least one of the pre-conditions you specified did not hold</Message></Error>`;
                    res.writeHead(412, { "content-type": "application/xml" });
                    res.end(xml);
                    return;
                }
                const partFiles = fs.existsSync(uploadDir)
                    ? fs
                          .readdirSync(uploadDir)
                          .filter(f => f.startsWith("part-") && f.endsWith(".bin"))
                          .sort()
                    : [];
                const buffers = partFiles.map(f =>
                    fs.readFileSync(path.join(uploadDir, f))
                );
                const combined = Buffer.concat(buffers);
                const etag = crypto.createHash("md5").update(combined).digest("hex");
                fs.mkdirSync(path.dirname(dataPath), { recursive: true });
                fs.writeFileSync(dataPath, combined);
                fs.writeFileSync(
                    metaPath,
                    JSON.stringify(
                        {
                            bucket,
                            key,
                            size: combined.length,
                            etag,
                            lastModified: new Date().toISOString()
                        },
                        null,
                        2
                    )
                );
                fs.rmSync(uploadDir, { recursive: true, force: true });
                const xml =
                    `<?xml version="1.0" encoding="UTF-8"?>` +
                    `<CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
                    `<Location>http://127.0.0.1:${port}/${xmlEscape(bucket)}/${xmlEscape(key)}</Location>` +
                    `<Bucket>${xmlEscape(bucket)}</Bucket>` +
                    `<Key>${xmlEscape(key)}</Key>` +
                    `<ETag>&quot;${etag}&quot;</ETag>` +
                    `</CompleteMultipartUploadResult>`;
                res.writeHead(200, { "content-type": "application/xml" });
                res.end(xml);
                return;
            }

            // AbortMultipartUpload: DELETE /<bucket>/<key>?uploadId=ID
            if (req.method === "DELETE" && query.uploadId) {
                const uploadDir = path.join(storageDir, "uploads", query.uploadId);
                fs.rmSync(uploadDir, { recursive: true, force: true });
                res.writeHead(204);
                res.end();
                return;
            }

            // PutObject: PUT /<bucket>/<key>
            if (req.method === "PUT" && key) {
                const { dataPath, metaPath } = encodeObjectPath(
                    storageDir,
                    bucket,
                    key
                );
                if (
                    req.headers["if-none-match"] === "*" &&
                    fs.existsSync(dataPath) &&
                    fs.existsSync(metaPath)
                ) {
                    const xml =
                        `<?xml version="1.0" encoding="UTF-8"?>` +
                        `<Error><Code>PreconditionFailed</Code><Message>At least one of the pre-conditions you specified did not hold</Message></Error>`;
                    res.writeHead(412, { "content-type": "application/xml" });
                    res.end(xml);
                    return;
                }
                const etag = crypto.createHash("md5").update(body).digest("hex");
                fs.mkdirSync(path.dirname(dataPath), { recursive: true });
                fs.writeFileSync(dataPath, body);
                fs.writeFileSync(
                    metaPath,
                    JSON.stringify(
                        {
                            bucket,
                            key,
                            size: body.length,
                            etag,
                            lastModified: new Date().toISOString()
                        },
                        null,
                        2
                    )
                );
                res.writeHead(200, { ETag: `"${etag}"` });
                res.end();
                return;
            }

            // GetObject / HeadObject: GET or HEAD /<bucket>/<key>
            if ((req.method === "GET" || req.method === "HEAD") && key) {
                const { dataPath, metaPath } = encodeObjectPath(
                    storageDir,
                    bucket,
                    key
                );
                if (!fs.existsSync(dataPath) || !fs.existsSync(metaPath)) {
                    const xml =
                        `<?xml version="1.0" encoding="UTF-8"?>` +
                        `<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message><Key>${xmlEscape(key)}</Key></Error>`;
                    res.writeHead(404, { "content-type": "application/xml" });
                    res.end(req.method === "HEAD" ? undefined : xml);
                    return;
                }
                const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
                const data = fs.readFileSync(dataPath);
                const rangeHeader = req.headers.range;
                if (req.method === "GET" && typeof rangeHeader === "string") {
                    const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader.trim());
                    if (match) {
                        const start = Number(match[1]);
                        const end = match[2] !== "" ? Number(match[2]) : data.length - 1;
                        if (start >= 0 && end >= start && end < data.length) {
                            const slice = data.subarray(start, end + 1);
                            res.writeHead(206, {
                                "content-type": "application/octet-stream",
                                "content-length": String(slice.length),
                                "content-range": `bytes ${start}-${end}/${data.length}`,
                                "accept-ranges": "bytes",
                                ETag: `"${meta.etag}"`,
                                "Last-Modified": new Date(meta.lastModified).toUTCString()
                            });
                            res.end(slice);
                            return;
                        }
                    }
                    res.writeHead(416, {
                        "content-range": `bytes */${data.length}`
                    });
                    res.end();
                    return;
                }
                res.writeHead(200, {
                    "content-type": "application/octet-stream",
                    "content-length": String(data.length),
                    "accept-ranges": "bytes",
                    ETag: `"${meta.etag}"`,
                    "Last-Modified": new Date(meta.lastModified).toUTCString()
                });
                if (req.method === "HEAD") {
                    res.end();
                } else {
                    res.end(data);
                }
                return;
            }

            // DeleteObject: DELETE /<bucket>/<key>
            if (req.method === "DELETE" && key) {
                const { dataPath, metaPath } = encodeObjectPath(
                    storageDir,
                    bucket,
                    key
                );
                fs.rmSync(dataPath, { force: true });
                fs.rmSync(metaPath, { force: true });
                res.writeHead(204);
                res.end();
                return;
            }

            res.writeHead(400, { "content-type": "text/plain" });
            res.end("Unsupported S3 request");
        });
    });

    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(Number(port), "127.0.0.1", resolve);
    });

    if (pidFile) {
        fs.writeFileSync(pidFile, String(process.pid));
    }

    process.on("SIGTERM", () => {
        server.close(() => process.exit(0));
    });
    process.on("SIGINT", () => {
        server.close(() => process.exit(0));
    });
}

async function getFreePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(0, "127.0.0.1", () => {
            const addr = srv.address();
            const port = typeof addr === "object" && addr ? addr.port : 0;
            srv.close(() => resolve(port));
        });
        srv.on("error", reject);
    });
}

async function httpGetJson(url) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, res => {
            const chunks = [];
            res.on("data", c => chunks.push(c));
            res.on("end", () => {
                try {
                    const body = Buffer.concat(chunks).toString("utf8");
                    resolve({
                        statusCode: res.statusCode,
                        data: JSON.parse(body)
                    });
                } catch (err) {
                    reject(err);
                }
            });
        });
        req.on("error", reject);
    });
}

function parseActionKeyValueFile(filePath) {
    if (!fs.existsSync(filePath)) {
        return {};
    }
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split(/\r?\n/);
    const result = {};
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        if (!line) {
            i++;
            continue;
        }
        const delimiterIdx = line.indexOf("<<");
        const eqIdx = line.indexOf("=");
        if (delimiterIdx !== -1 && (eqIdx === -1 || delimiterIdx < eqIdx)) {
            const key = line.slice(0, delimiterIdx);
            const delimiter = line.slice(delimiterIdx + 2);
            const valueLines = [];
            i++;
            while (i < lines.length && lines[i] !== delimiter) {
                valueLines.push(lines[i]);
                i++;
            }
            result[key] = valueLines.join("\n");
            i++;
        } else if (eqIdx !== -1) {
            const key = line.slice(0, eqIdx);
            const val = line.slice(eqIdx + 1);
            result[key] = val;
            i++;
        } else {
            i++;
        }
    }
    return result;
}

async function startS3(flags) {
    const runDir = path.resolve(flags["run-dir"] || "/tmp/cache-s3-verify");
    const port = Number(flags.port || (await getFreePort()));
    const storageDir = path.join(runDir, "s3-storage");
    const pidFile = path.join(runDir, "s3-server.pid");
    const configFile = path.join(runDir, "instance.json");
    const logFile = path.join(runDir, "s3-server.log");

    fs.mkdirSync(runDir, { recursive: true });

    if (fs.existsSync(pidFile)) {
        const existingPid = Number(fs.readFileSync(pidFile, "utf8").trim());
        try {
            process.kill(existingPid, 0);
            console.error(
                `Refusing to start: existing S3 server process ${existingPid} is already running in ${runDir}`
            );
            process.exit(1);
        } catch {
            fs.rmSync(pidFile, { force: true });
        }
    }

    const outFd = fs.openSync(logFile, "a");
    const child = spawn(
        process.execPath,
        [
            __filename,
            "s3-server",
            "--port",
            String(port),
            "--storage-dir",
            storageDir,
            "--pid-file",
            pidFile
        ],
        {
            detached: true,
            stdio: ["ignore", outFd, outFd]
        }
    );
    child.unref();

    const endpoint = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 40; i++) {
        try {
            const resp = await httpGetJson(`${endpoint}/__health`);
            if (resp.statusCode === 200 && resp.data.ok) {
                ready = true;
                break;
            }
        } catch {
            // wait
        }
        await new Promise(r => setTimeout(r, 100));
    }

    if (!ready) {
        console.error(`S3 server failed to become ready on ${endpoint}`);
        process.exit(1);
    }

    const instanceInfo = {
        pid: child.pid,
        port,
        endpoint,
        runDir,
        storageDir,
        bucket: flags.bucket || "verify-bucket",
        startedAt: new Date().toISOString()
    };
    fs.writeFileSync(configFile, JSON.stringify(instanceInfo, null, 2));
    console.log(JSON.stringify(instanceInfo, null, 2));
}

async function stopS3(flags) {
    const runDir = path.resolve(flags["run-dir"] || "/tmp/cache-s3-verify");
    const pidFile = path.join(runDir, "s3-server.pid");
    if (!fs.existsSync(pidFile)) {
        console.log(JSON.stringify({ stopped: false, reason: "no pid file" }));
        return;
    }
    const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    let killed = false;
    try {
        process.kill(pid, "SIGTERM");
        killed = true;
    } catch {
        // already dead
    }
    fs.rmSync(pidFile, { force: true });
    console.log(JSON.stringify({ stopped: true, pid, killed }));
}

async function doctor(flags) {
    const runDir = path.resolve(flags["run-dir"] || "/tmp/cache-s3-verify");
    const configFile = path.join(runDir, "instance.json");
    if (!fs.existsSync(configFile)) {
        console.error(
            JSON.stringify({
                healthy: false,
                error: `Missing instance config at ${configFile}`
            })
        );
        process.exit(1);
    }
    const instance = JSON.parse(fs.readFileSync(configFile, "utf8"));

    let processAlive = false;
    try {
        process.kill(instance.pid, 0);
        processAlive = true;
    } catch {
        processAlive = false;
    }

    let healthResp = null;
    try {
        const resp = await httpGetJson(`${instance.endpoint}/__health`);
        if (resp.statusCode === 200 && resp.data.ok) {
            healthResp = resp.data;
        }
    } catch {
        healthResp = null;
    }

    const distBundles = [
        "dist/restore/index.js",
        "dist/save/index.js",
        "dist/restore-only/index.js",
        "dist/save-only/index.js"
    ];
    const missingBundles = distBundles.filter(
        b => !fs.existsSync(path.join(REPO_ROOT, b))
    );

    const healthy =
        processAlive &&
        healthResp !== null &&
        healthResp.pid === instance.pid &&
        missingBundles.length === 0;

    const report = {
        healthy,
        pid: instance.pid,
        processAlive,
        endpoint: instance.endpoint,
        bucket: instance.bucket,
        runDir: instance.runDir,
        storageDir: instance.storageDir,
        distBundlesReady: missingBundles.length === 0,
        missingBundles
    };

    console.log(JSON.stringify(report, null, 2));
    if (!healthy) {
        process.exit(1);
    }
}

async function runAction(flags, inputs, extraEnvs) {
    const runDir = path.resolve(flags["run-dir"] || "/tmp/cache-s3-verify");
    const configFile = path.join(runDir, "instance.json");
    const instance = fs.existsSync(configFile)
        ? JSON.parse(fs.readFileSync(configFile, "utf8"))
        : null;

    const entry = flags.entry;
    const entryMap = {
        restore: path.join(REPO_ROOT, "dist/restore/index.js"),
        save: path.join(REPO_ROOT, "dist/save/index.js"),
        "restore-only": path.join(REPO_ROOT, "dist/restore-only/index.js"),
        "save-only": path.join(REPO_ROOT, "dist/save-only/index.js")
    };
    const scriptPath = entryMap[entry];
    if (!scriptPath || !fs.existsSync(scriptPath)) {
        console.error(`Invalid or unbuilt --entry "${entry}"`);
        process.exit(1);
    }

    const stateFile = path.join(runDir, "github_state.txt");
    const outputFile = path.join(runDir, "github_output.txt");
    if (flags["reset-state"] === "true") {
        fs.rmSync(stateFile, { force: true });
    }
    // Always reset output file for the current step so outputs reflect this execution
    fs.writeFileSync(outputFile, "");
    if (!fs.existsSync(stateFile)) {
        fs.writeFileSync(stateFile, "");
    }

    // Load previously saved state from GITHUB_STATE and expose as STATE_<key>
    const priorStates = parseActionKeyValueFile(stateFile);
    const stateEnv = {};
    for (const [k, v] of Object.entries(priorStates)) {
        stateEnv[`STATE_${k}`] = v;
    }

    // Convert inputs to INPUT_<UPPERCASE_NAME> (preserving hyphens, matching @actions/core getInput)
    const inputEnv = {};
    for (const [k, v] of Object.entries(inputs)) {
        inputEnv[`INPUT_${k.replace(/ /g, "_").toUpperCase()}`] = v;
    }

    const workDir = flags.cwd
        ? path.resolve(flags.cwd)
        : path.join(runDir, "workspace");
    fs.mkdirSync(workDir, { recursive: true });

    const useS3 = flags["no-s3"] !== "true" && instance !== null;

    const childEnv = {
        ...process.env,
        GITHUB_EVENT_NAME: "push",
        GITHUB_REF: "refs/heads/main",
        GITHUB_REPOSITORY: "toyamagu-2021/cache-s3",
        GITHUB_WORKSPACE: workDir,
        GITHUB_OUTPUT: outputFile,
        GITHUB_STATE: stateFile,
        ...(useS3
            ? {
                  CACHE_S3_BUCKET: instance.bucket,
                  CACHE_S3_ENDPOINT: instance.endpoint,
                  CACHE_S3_FORCE_PATH_STYLE: "true",
                  AWS_REGION: "us-east-1",
                  AWS_ACCESS_KEY_ID: "test-access-key",
                  AWS_SECRET_ACCESS_KEY: "test-secret-key"
              }
            : {}),
        ...stateEnv,
        ...inputEnv,
        ...extraEnvs
    };

    if (flags["no-s3"] === "true") {
        delete childEnv.CACHE_S3_BUCKET;
        delete childEnv.CACHE_S3_ENDPOINT;
        delete childEnv.CACHE_S3_FORCE_PATH_STYLE;
    }

    if (flags["path-override"]) {
        childEnv.PATH = flags["path-override"];
    }

    const stdoutChunks = [];
    const stderrChunks = [];

    const exitCode = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [scriptPath], {
            cwd: workDir,
            env: childEnv,
            stdio: ["ignore", "pipe", "pipe"]
        });
        child.stdout.on("data", d => stdoutChunks.push(d));
        child.stderr.on("data", d => stderrChunks.push(d));
        child.on("error", reject);
        child.on("close", code => resolve(code ?? 0));
    });

    const stdout = Buffer.concat(stdoutChunks).toString("utf8");
    const stderr = Buffer.concat(stderrChunks).toString("utf8");
    const outputs = parseActionKeyValueFile(outputFile);
    const states = parseActionKeyValueFile(stateFile);

    const record = {
        entry,
        exitCode,
        cwd: workDir,
        inputs,
        outputs,
        states,
        stdout,
        stderr
    };

    if (flags["evidence-file"]) {
        const evidencePath = path.resolve(flags["evidence-file"]);
        fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
        fs.writeFileSync(evidencePath, JSON.stringify(record, null, 2));
    }

    console.log(JSON.stringify(record, null, 2));
    if (flags["allow-failure"] !== "true" && exitCode !== 0) {
        process.exit(exitCode);
    }
}

async function listObjects(flags) {
    const runDir = path.resolve(flags["run-dir"] || "/tmp/cache-s3-verify");
    const configFile = path.join(runDir, "instance.json");
    if (!fs.existsSync(configFile)) {
        console.error(`Missing instance config at ${configFile}`);
        process.exit(1);
    }
    const instance = JSON.parse(fs.readFileSync(configFile, "utf8"));
    const bucket = flags.bucket || instance.bucket;
    const prefix = flags.prefix || "";
    const url = `${instance.endpoint}/__objects?bucket=${encodeURIComponent(bucket)}&prefix=${encodeURIComponent(prefix)}`;
    const resp = await httpGetJson(url);
    if (flags["evidence-file"]) {
        const evidencePath = path.resolve(flags["evidence-file"]);
        fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
        fs.writeFileSync(evidencePath, JSON.stringify(resp.data, null, 2));
    }
    console.log(JSON.stringify(resp.data, null, 2));
}

async function cleanup(flags) {
    const runDir = path.resolve(flags["run-dir"] || "/tmp/cache-s3-verify");
    await stopS3(flags);
    fs.rmSync(runDir, { recursive: true, force: true });
    console.log(JSON.stringify({ cleanedUp: true, runDir }));
}

async function main() {
    const { command, flags, inputs, envs } = parseArgs(process.argv.slice(2));
    switch (command) {
        case "s3-server":
            await runS3Server(
                flags.port || 9000,
                flags["storage-dir"],
                flags["pid-file"]
            );
            break;
        case "start-s3":
            await startS3(flags);
            break;
        case "stop-s3":
            await stopS3(flags);
            break;
        case "doctor":
            await doctor(flags);
            break;
        case "run-action":
            await runAction(flags, inputs, envs);
            break;
        case "list-objects":
            await listObjects(flags);
            break;
        case "cleanup":
            await cleanup(flags);
            break;
        default:
            console.error(
                "Usage: control-cache-s3 <start-s3|stop-s3|doctor|run-action|list-objects|cleanup> [options]"
            );
            process.exit(1);
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
