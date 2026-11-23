import {
    afterEach,
    beforeEach,
    describe,
    expect,
    jest,
    test
} from "@jest/globals";
import * as fs from "fs";
import { Readable } from "stream";

const mockExec = jest.fn<(tool: string, args?: string[]) => Promise<number>>();
const mockWhich = jest.fn<(tool: string, check?: boolean) => Promise<string>>();
const mockGlobCreate =
    jest.fn<
        (
            pattern: string,
            options?: Record<string, unknown>
        ) => Promise<{ glob: () => Promise<string[]> }>
    >();
const mockSend =
    jest.fn<
        (
            command: { input: Record<string, unknown> },
            options?: { abortSignal?: AbortSignal }
        ) => Promise<unknown>
    >();
const mockUploadDone = jest.fn<() => Promise<void>>();
const mockUploadOn =
    jest.fn<
        (
            event: string,
            listener: (progress: { part?: number; loaded?: number }) => void
        ) => void
    >();
const mockUpload = jest.fn<
    (options: {
        params: { Key: string };
        partSize: number;
        queueSize: number;
    }) => {
        on: typeof mockUploadOn;
        done: () => Promise<void>;
    }
>(() => ({ on: mockUploadOn, done: mockUploadDone }));
const mockWarning = jest.fn<(message: string | Error) => void>();
const mockInfo = jest.fn<(message: string) => void>();
const mockDebug = jest.fn<(message: string) => void>();
const mockIsDebug = jest.fn<() => boolean>(() => false);

jest.unstable_mockModule("@actions/core", () => ({
    warning: mockWarning,
    info: mockInfo,
    debug: mockDebug,
    isDebug: mockIsDebug
}));
jest.unstable_mockModule("@actions/exec", () => ({ exec: mockExec }));
jest.unstable_mockModule("@actions/io", () => ({ which: mockWhich }));
jest.unstable_mockModule("@actions/glob", () => ({ create: mockGlobCreate }));

const mockS3Client = jest.fn<
    (config: Record<string, unknown>) => { send: typeof mockSend }
>(() => ({ send: mockSend }));

jest.unstable_mockModule("@aws-sdk/client-s3", () => ({
    S3Client: mockS3Client,
    ListObjectsV2Command: jest.fn(input => ({ input })),
    GetObjectCommand: jest.fn(input => ({ input }))
}));

jest.unstable_mockModule("@aws-sdk/lib-storage", () => ({
    Upload: mockUpload
}));

type S3CacheModule = typeof import("../src/s3/s3Cache");

// bucketName and the S3 client are captured at module load, so the module has
// to be evaluated after the env vars are in place.
async function loadS3Cache(): Promise<S3CacheModule> {
    jest.resetModules();
    return await import("../src/s3/s3Cache");
}

function mockAvailableTools(...tools: string[]): void {
    mockWhich.mockImplementation(async (tool: string) => {
        if (!tools.includes(tool)) {
            throw new Error(`Unable to locate executable file: ${tool}`);
        }
        return `/usr/bin/${tool}`;
    });
}

function tarArgs(): string[] {
    expect(mockExec).toHaveBeenCalledTimes(1);
    expect(mockExec.mock.calls[0][0]).toBe("tar");
    return mockExec.mock.calls[0][1] as string[];
}

beforeEach(() => {
    process.env["CACHE_S3_BUCKET"] = "test-bucket";
    process.env["AWS_REGION"] = "us-east-1";
    process.env["GITHUB_REPOSITORY"] = "owner/repo";

    // No zstd on PATH keeps saveCache on the single-command gzip path.
    mockWhich.mockRejectedValue(new Error("not found"));
    mockGlobCreate.mockResolvedValue({
        glob: async () => ["/tmp/cached-dir"]
    });
    mockUploadDone.mockResolvedValue(undefined);
    mockUploadOn.mockReset();
    mockUpload.mockClear();
    mockS3Client.mockClear();
    mockWarning.mockClear();
    mockInfo.mockClear();
    mockDebug.mockClear();
    mockIsDebug.mockReset();
    mockIsDebug.mockReturnValue(false);
    mockSend.mockClear();
    mockExec.mockClear();

    // exec is mocked, so the archive that saveCache stats and uploads has to
    // be faked here.
    mockExec.mockImplementation(async (_tool: string, args: string[] = []) => {
        const outputIndex = args.findIndex(arg => /^-c[z]?f$/.test(arg));
        if (outputIndex !== -1) {
            await fs.promises.writeFile(args[outputIndex + 1], "archive");
        }
        return 0;
    });
});

afterEach(() => {
    delete process.env["CACHE_S3_BUCKET"];
    delete process.env["AWS_REGION"];
    delete process.env["AWS_DEFAULT_REGION"];
    delete process.env["AWS_ACCESS_KEY_ID"];
    delete process.env["AWS_SECRET_ACCESS_KEY"];
    delete process.env["AWS_SESSION_TOKEN"];
    delete process.env["GITHUB_REPOSITORY"];
    delete process.env["CACHE_S3_PREFIX"];
    delete process.env["CACHE_S3_FORCE_PATH_STYLE"];
    delete process.env["AWS_S3_FORCE_PATH_STYLE"];
    delete process.env["CACHE_S3_UNSET_AWS_CREDENTIALS"];
    delete process.env["CACHE_S3_UPLOAD_QUEUE_SIZE"];
    delete process.env["CACHE_S3_UPLOAD_PART_SIZE"];
    delete process.env["CACHE_S3_DOWNLOAD_QUEUE_SIZE"];
    delete process.env["CACHE_S3_DOWNLOAD_PART_SIZE"];
    delete process.env["CACHE_S3_DOWNLOAD_TIMEOUT_MS"];
});

describe("saveCache", () => {
    test("hands directories to tar instead of expanding them into descendants", async () => {
        await (await loadS3Cache()).saveCache(["/tmp/cached-dir"], "key");

        expect(mockGlobCreate).toHaveBeenCalledWith("/tmp/cached-dir", {
            implicitDescendants: false
        });
    });

    test("compresses with a single-pass tar pipeline when zstd is available", async () => {
        mockAvailableTools("zstd", "unzstd");

        await (await loadS3Cache()).saveCache(["/tmp/cached-dir"], "key");

        const args = tarArgs();
        expect(args.slice(0, 3)).toEqual([
            "--use-compress-program",
            "zstd -T0",
            "-cf"
        ]);
        expect(args[3]).toMatch(/cache\.tar\.zst$/);
        expect(args.slice(4)).toEqual(["-T", `${args[3]}.manifest`]);
    });

    test("compresses in one pass with gzip when zstd is unavailable", async () => {
        await (await loadS3Cache()).saveCache(["/tmp/cached-dir"], "key");

        const args = tarArgs();
        expect(args[0]).toBe("-czf");
        expect(args[1]).toMatch(/cache\.tar\.gz$/);
        expect(args.slice(2)).toEqual(["-T", `${args[1]}.manifest`]);
    });

    test("validates paths and key before resolving paths or calling S3", async () => {
        mockGlobCreate.mockClear();
        mockUpload.mockClear();
        const s3 = await loadS3Cache();

        await expect(s3.saveCache([], "key")).rejects.toThrow(
            "Path Validation Error: At least one directory or file path is required"
        );
        await expect(s3.saveCache(["/tmp/cached-dir"], "")).rejects.toThrow(
            "Key Validation Error: Key cannot be empty."
        );
        await expect(s3.saveCache(["/tmp/cached-dir"], "a,b")).rejects.toThrow(
            "Key Validation Error: a,b cannot contain commas."
        );
        const longKey = "a".repeat(513);
        await expect(
            s3.saveCache(["/tmp/cached-dir"], longKey)
        ).rejects.toThrow(
            `Key Validation Error: ${longKey} cannot be larger than 512 characters.`
        );
        expect(mockGlobCreate).not.toHaveBeenCalled();
        expect(mockUpload).not.toHaveBeenCalled();
    });

    test("isolates Windows cache version unless enableCrossOsArchive is true", async () => {
        const originalPlatform = Object.getOwnPropertyDescriptor(
            process,
            "platform"
        );

        try {
            const s3 = await loadS3Cache();

            Object.defineProperty(process, "platform", { value: "linux" });
            mockUpload.mockClear();
            await s3.saveCache(["/tmp/cached-dir"], "key", false);
            const linuxKey = mockUpload.mock.calls[0][0].params.Key;

            Object.defineProperty(process, "platform", { value: "win32" });
            mockUpload.mockClear();
            await s3.saveCache(["/tmp/cached-dir"], "key", false);
            const winKey = mockUpload.mock.calls[0][0].params.Key;

            mockUpload.mockClear();
            await s3.saveCache(["/tmp/cached-dir"], "key", true);
            const crossOsKey = mockUpload.mock.calls[0][0].params.Key;

            expect(winKey).not.toBe(linuxKey);
            expect(crossOsKey).toBe(linuxKey);
        } finally {
            if (originalPlatform) {
                Object.defineProperty(process, "platform", originalPlatform);
            }
        }
    });
});

describe("restoreCache", () => {
    beforeEach(() => {
        mockSend.mockImplementation(
            async (command: { input: Record<string, string> }) => {
                if ("Prefix" in command.input) {
                    return {
                        Contents: [
                            {
                                Key: command.input.Prefix,
                                LastModified: new Date()
                            }
                        ]
                    };
                }
                return { Body: Readable.from(["archive"]) };
            }
        );
    });

    test("extracts with a single-pass tar pipeline when zstd is available", async () => {
        mockAvailableTools("zstd", "unzstd");

        const key = await (
            await loadS3Cache()
        ).restoreCache(["/tmp/cached-dir"], "key");

        expect(key).toBe("key");
        expect(tarArgs()).toEqual([
            "--use-compress-program",
            "unzstd",
            "-xf",
            expect.stringMatching(/cache\.tar\.zst$/),
            "-C",
            "/"
        ]);
    });

    test("falls back to `zstd -d` when unzstd is not on PATH", async () => {
        mockAvailableTools("zstd");

        const key = await (
            await loadS3Cache()
        ).restoreCache(["/tmp/cached-dir"], "key");

        expect(key).toBe("key");
        expect(tarArgs().slice(0, 2)).toEqual([
            "--use-compress-program",
            "zstd -d"
        ]);
    });

    test("extracts in one pass with gzip when zstd is unavailable", async () => {
        const key = await (
            await loadS3Cache()
        ).restoreCache(["/tmp/cached-dir"], "key");

        expect(key).toBe("key");
        expect(tarArgs()).toEqual([
            "-xzf",
            expect.stringMatching(/cache\.tar\.gz$/),
            "-C",
            "/"
        ]);
    });

    test("skips download and extraction when lookupOnly is true", async () => {
        mockSend.mockClear();
        mockExec.mockClear();

        const key = await (
            await loadS3Cache()
        ).restoreCache(["/tmp/cached-dir"], "key", [], { lookupOnly: true });

        expect(key).toBe("key");
        expect(mockSend).toHaveBeenCalledTimes(1);
        expect(mockExec).not.toHaveBeenCalled();
    });

    test("validates paths and keys before calling S3", async () => {
        mockSend.mockClear();
        const s3 = await loadS3Cache();

        await expect(s3.restoreCache([], "key")).rejects.toThrow(
            "Path Validation Error: At least one directory or file path is required"
        );
        await expect(s3.restoreCache(["/tmp/cached-dir"], "")).rejects.toThrow(
            "Key Validation Error: Key cannot be empty."
        );
        await expect(
            s3.restoreCache(["/tmp/cached-dir"], "primary", [""])
        ).rejects.toThrow("Key Validation Error: Key cannot be empty.");
        await expect(
            s3.restoreCache(["/tmp/cached-dir"], "a,b")
        ).rejects.toThrow("Key Validation Error: a,b cannot contain commas.");
        const longKey = "a".repeat(513);
        await expect(
            s3.restoreCache(["/tmp/cached-dir"], longKey)
        ).rejects.toThrow(
            `Key Validation Error: ${longKey} cannot be larger than 512 characters.`
        );
        const manyRestoreKeys = Array.from({ length: 10 }, (_, i) => `k${i}`);
        await expect(
            s3.restoreCache(["/tmp/cached-dir"], "primary", manyRestoreKeys)
        ).rejects.toThrow(
            "Key Validation Error: Keys are limited to a maximum of 10."
        );
        expect(mockSend).not.toHaveBeenCalled();
    });

    test("isolates Windows cache version unless enableCrossOsArchive is true", async () => {
        const originalPlatform = Object.getOwnPropertyDescriptor(
            process,
            "platform"
        );

        try {
            const s3 = await loadS3Cache();

            Object.defineProperty(process, "platform", { value: "linux" });
            mockSend.mockClear();
            await s3.restoreCache(
                ["/tmp/cached-dir"],
                "key",
                [],
                { lookupOnly: true },
                false
            );
            const linuxPrefix = mockSend.mock.calls[0][0].input.Prefix;

            Object.defineProperty(process, "platform", { value: "win32" });
            mockSend.mockClear();
            await s3.restoreCache(
                ["/tmp/cached-dir"],
                "key",
                [],
                { lookupOnly: true },
                false
            );
            const winPrefix = mockSend.mock.calls[0][0].input.Prefix;

            mockSend.mockClear();
            await s3.restoreCache(
                ["/tmp/cached-dir"],
                "key",
                [],
                { lookupOnly: true },
                true
            );
            const crossOsPrefix = mockSend.mock.calls[0][0].input.Prefix;

            expect(winPrefix).not.toBe(linuxPrefix);
            expect(crossOsPrefix).toBe(linuxPrefix);
        } finally {
            if (originalPlatform) {
                Object.defineProperty(process, "platform", originalPlatform);
            }
        }
    });

    test("rejects 0-byte object from S3 listing without downloading or extracting", async () => {
        mockSend.mockImplementation(
            async (command: { input: Record<string, unknown> }) => {
                if ("Prefix" in command.input) {
                    return {
                        Contents: [
                            {
                                Key: command.input.Prefix,
                                LastModified: new Date(),
                                Size: 0
                            }
                        ]
                    };
                }
                throw new Error("GetObjectCommand should not be called");
            }
        );

        const key = await (
            await loadS3Cache()
        ).restoreCache(["/tmp/cached-dir"], "key");

        expect(key).toBeUndefined();
        expect(mockSend).toHaveBeenCalledTimes(1);
        expect(mockExec).not.toHaveBeenCalled();
        expect(mockWarning).toHaveBeenCalledWith(
            expect.stringContaining("0 bytes")
        );
    });

    test("rejects empty downloaded stream and returns undefined after retries", async () => {
        mockSend.mockImplementation(
            async (command: { input: Record<string, unknown> }) => {
                if ("Prefix" in command.input) {
                    return {
                        Contents: [
                            {
                                Key: command.input.Prefix,
                                LastModified: new Date()
                            }
                        ]
                    };
                }
                return { Body: Readable.from([]) };
            }
        );

        const key = await (
            await loadS3Cache()
        ).restoreCache(["/tmp/cached-dir"], "key");

        expect(key).toBeUndefined();
        // 1 ListObjectsV2 + 3 GetObject attempts
        expect(mockSend).toHaveBeenCalledTimes(4);
        expect(mockExec).not.toHaveBeenCalled();
        expect(mockWarning).toHaveBeenCalledWith(
            expect.stringContaining("0 bytes")
        );
    });

    test("retries truncated single-object download and succeeds when full size arrives", async () => {
        let getAttempts = 0;
        mockSend.mockImplementation(
            async (command: { input: Record<string, unknown> }) => {
                if ("Prefix" in command.input) {
                    return {
                        Contents: [
                            {
                                Key: command.input.Prefix,
                                LastModified: new Date(),
                                Size: 7
                            }
                        ]
                    };
                }
                getAttempts++;
                if (getAttempts === 1) {
                    return { Body: Readable.from(["arc"]) };
                }
                return { Body: Readable.from(["archive"]) };
            }
        );

        const key = await (
            await loadS3Cache()
        ).restoreCache(["/tmp/cached-dir"], "key");

        expect(key).toBe("key");
        expect(getAttempts).toBe(2);
        expect(mockExec).toHaveBeenCalledTimes(1);
    });

    test("returns undefined when single-object download fails size check across all retries", async () => {
        let getAttempts = 0;
        mockSend.mockImplementation(
            async (command: { input: Record<string, unknown> }) => {
                if ("Prefix" in command.input) {
                    return {
                        Contents: [
                            {
                                Key: command.input.Prefix,
                                LastModified: new Date(),
                                Size: 7
                            }
                        ]
                    };
                }
                getAttempts++;
                return { Body: Readable.from(["arc"]) };
            }
        );

        const key = await (
            await loadS3Cache()
        ).restoreCache(["/tmp/cached-dir"], "key");

        expect(key).toBeUndefined();
        expect(getAttempts).toBe(3);
        expect(mockExec).not.toHaveBeenCalled();
        expect(mockWarning).toHaveBeenCalledWith(
            expect.stringContaining("size mismatch")
        );
    });

    test("downloads large objects via concurrent Range requests, respects queue size, reassembles bytes, and retries only failed or oversized segments without corrupting adjacent ranges", async () => {
        process.env["CACHE_S3_DOWNLOAD_PART_SIZE"] = "4";
        process.env["CACHE_S3_DOWNLOAD_QUEUE_SIZE"] = "2";

        const fullPayload = Buffer.from("0123456789");
        const rangeCalls: Record<string, number> = {};
        let inFlight = 0;
        let maxInFlight = 0;
        let restoredBytes: Buffer | undefined;

        mockSend.mockImplementation(
            async (command: { input: Record<string, unknown> }) => {
                if ("Prefix" in command.input) {
                    return {
                        Contents: [
                            {
                                Key: command.input.Prefix,
                                LastModified: new Date(),
                                Size: fullPayload.length
                            }
                        ]
                    };
                }
                const rangeHeader = command.input.Range as string;
                rangeCalls[rangeHeader] = (rangeCalls[rangeHeader] ?? 0) + 1;

                inFlight++;
                maxInFlight = Math.max(maxInFlight, inFlight);
                await new Promise(resolve => setTimeout(resolve, 10));
                inFlight--;

                // First segment returns oversized full body on attempt 1 (e.g. proxy ignoring Range)
                if (
                    rangeHeader === "bytes=0-3" &&
                    rangeCalls[rangeHeader] === 1
                ) {
                    return {
                        Body: Readable.from([Buffer.from("0123CORRUPT")])
                    };
                }

                // Middle segment fails with mismatched ContentRange on attempt 1
                if (
                    rangeHeader === "bytes=4-7" &&
                    rangeCalls[rangeHeader] === 1
                ) {
                    return {
                        ContentRange: "bytes 0-3/10",
                        Body: Readable.from([Buffer.from("0123")])
                    };
                }

                // Last segment returns extra tail bytes on attempt 1
                if (
                    rangeHeader === "bytes=8-9" &&
                    rangeCalls[rangeHeader] === 1
                ) {
                    return {
                        Body: Readable.from([Buffer.from("89EXTRA")])
                    };
                }

                const match = /^bytes=(\d+)-(\d+)$/.exec(rangeHeader);
                expect(match).not.toBeNull();
                const start = Number(match![1]);
                const end = Number(match![2]);
                return {
                    ContentRange: `bytes ${start}-${end}/${fullPayload.length}`,
                    Body: Readable.from([fullPayload.subarray(start, end + 1)])
                };
            }
        );

        mockExec.mockImplementation(
            async (_tool: string, args: string[] = []) => {
                const xfIdx = args.findIndex(arg => /^-x[z]?f$/.test(arg));
                if (xfIdx !== -1) {
                    restoredBytes = await fs.promises.readFile(args[xfIdx + 1]);
                }
                return 0;
            }
        );

        const key = await (
            await loadS3Cache()
        ).restoreCache(["/tmp/cached-dir"], "key");

        expect(key).toBe("key");
        expect(maxInFlight).toBeLessThanOrEqual(2);
        expect(rangeCalls).toEqual({
            "bytes=0-3": 2,
            "bytes=4-7": 2,
            "bytes=8-9": 2
        });
        expect(restoredBytes?.toString()).toBe("0123456789");
    });
});

describe("S3 prefix and tuning configuration", () => {
    test("CACHE_S3_PREFIX overrides cache/<repo>/ while preserving <version>/ and trimming slashes", async () => {
        process.env["CACHE_S3_PREFIX"] = "/custom/prefix///";

        await (await loadS3Cache()).saveCache(["/tmp/cached-dir"], "my-key");

        expect(mockUpload).toHaveBeenCalledTimes(1);
        const uploadedKey = mockUpload.mock.calls[0][0].params.Key;
        expect(uploadedKey).toMatch(/^custom\/prefix\/[0-9a-f]{64}\/my-key$/);
    });

    test("whitespace or slash-only CACHE_S3_PREFIX falls back to cache/<repo>/", async () => {
        process.env["CACHE_S3_PREFIX"] = "  ///  ";

        await (await loadS3Cache()).saveCache(["/tmp/cached-dir"], "my-key");

        expect(mockUpload).toHaveBeenCalledTimes(1);
        const uploadedKey = mockUpload.mock.calls[0][0].params.Key;
        expect(uploadedKey).toMatch(
            /^cache\/owner\/repo\/[0-9a-f]{64}\/my-key$/
        );
    });

    test("passes CACHE_S3_UPLOAD_QUEUE_SIZE and CACHE_S3_UPLOAD_PART_SIZE to Upload", async () => {
        process.env["CACHE_S3_UPLOAD_QUEUE_SIZE"] = "8";
        process.env["CACHE_S3_UPLOAD_PART_SIZE"] = "5242880";

        await (await loadS3Cache()).saveCache(["/tmp/cached-dir"], "my-key");

        expect(mockUpload).toHaveBeenCalledTimes(1);
        expect(mockUpload.mock.calls[0][0].queueSize).toBe(8);
        expect(mockUpload.mock.calls[0][0].partSize).toBe(5242880);
        expect(mockWarning).not.toHaveBeenCalled();
    });

    test("invalid tuning env vars (including <5MiB upload part size, hex, scientific, or unsafe ints) warn and fall back to defaults", async () => {
        process.env["CACHE_S3_UPLOAD_QUEUE_SIZE"] = "0x10";
        process.env["CACHE_S3_UPLOAD_PART_SIZE"] = "1048576";
        process.env["CACHE_S3_DOWNLOAD_QUEUE_SIZE"] = "99999999999999999999";
        process.env["CACHE_S3_DOWNLOAD_PART_SIZE"] = "1e7";

        await (await loadS3Cache()).saveCache(["/tmp/cached-dir"], "my-key");

        expect(mockWarning).toHaveBeenCalledTimes(4);
        expect(mockUpload).toHaveBeenCalledTimes(1);
        expect(mockUpload.mock.calls[0][0].queueSize).toBe(4);
        expect(mockUpload.mock.calls[0][0].partSize).toBe(32 * 1024 * 1024);
    });
});

describe("S3 credential and path-style configuration", () => {
    test("CACHE_S3_UNSET_AWS_CREDENTIALS=true with CACHE_S3_BUCKET set clears AWS credentials and preserves regions", async () => {
        process.env["CACHE_S3_BUCKET"] = "test-bucket";
        process.env["CACHE_S3_UNSET_AWS_CREDENTIALS"] = "true";
        process.env["AWS_ACCESS_KEY_ID"] = "AKIAEXAMPLE";
        process.env["AWS_SECRET_ACCESS_KEY"] = "secret";
        process.env["AWS_SESSION_TOKEN"] = "token";
        process.env["AWS_REGION"] = "us-west-2";
        process.env["AWS_DEFAULT_REGION"] = "eu-west-1";

        await loadS3Cache();

        expect(process.env["AWS_ACCESS_KEY_ID"]).toBeUndefined();
        expect(process.env["AWS_SECRET_ACCESS_KEY"]).toBeUndefined();
        expect(process.env["AWS_SESSION_TOKEN"]).toBeUndefined();
        expect(process.env["AWS_REGION"]).toBe("us-west-2");
        expect(process.env["AWS_DEFAULT_REGION"]).toBe("eu-west-1");
    });

    test("CACHE_S3_UNSET_AWS_CREDENTIALS=true with CACHE_S3_BUCKET unset leaves AWS credentials intact", async () => {
        delete process.env["CACHE_S3_BUCKET"];
        process.env["CACHE_S3_UNSET_AWS_CREDENTIALS"] = "true";
        process.env["AWS_ACCESS_KEY_ID"] = "AKIAEXAMPLE";
        process.env["AWS_SECRET_ACCESS_KEY"] = "secret";
        process.env["AWS_SESSION_TOKEN"] = "token";

        const s3 = await loadS3Cache();

        expect(s3.isS3Available()).toBe(false);
        expect(process.env["AWS_ACCESS_KEY_ID"]).toBe("AKIAEXAMPLE");
        expect(process.env["AWS_SECRET_ACCESS_KEY"]).toBe("secret");
        expect(process.env["AWS_SESSION_TOKEN"]).toBe("token");
    });

    test("AWS_S3_FORCE_PATH_STYLE=true enables forcePathStyle when CACHE_S3_FORCE_PATH_STYLE is unset", async () => {
        delete process.env["CACHE_S3_FORCE_PATH_STYLE"];
        process.env["AWS_S3_FORCE_PATH_STYLE"] = "true";

        await loadS3Cache();

        expect(mockS3Client).toHaveBeenCalledWith(
            expect.objectContaining({ forcePathStyle: true })
        );
    });

    test("CACHE_S3_FORCE_PATH_STYLE=false overrides AWS_S3_FORCE_PATH_STYLE=true", async () => {
        process.env["CACHE_S3_FORCE_PATH_STYLE"] = "false";
        process.env["AWS_S3_FORCE_PATH_STYLE"] = "true";

        await loadS3Cache();

        expect(mockS3Client).toHaveBeenCalledWith(
            expect.objectContaining({ forcePathStyle: false })
        );
    });
});

describe("S3 download timeout", () => {
    test("stalled single download aborts on timeout and succeeds on retry", async () => {
        process.env["CACHE_S3_DOWNLOAD_TIMEOUT_MS"] = "50";
        let getAttempts = 0;

        mockSend.mockImplementation(async command => {
            if ("Prefix" in command.input) {
                return {
                    Contents: [
                        {
                            Key: `${command.input.Prefix}`,
                            LastModified: new Date(),
                            Size: 7
                        }
                    ]
                };
            }
            getAttempts++;
            if (getAttempts === 1) {
                return {
                    ContentLength: 7,
                    Body: new Readable({
                        read() {
                            // Never push data to simulate a stalled stream.
                        }
                    })
                };
            }
            return {
                ContentLength: 7,
                Body: Readable.from([Buffer.from("payload")])
            };
        });

        const key = await (
            await loadS3Cache()
        ).restoreCache(["/tmp/cached-dir"], "key");

        expect(key).toBe("key");
        expect(getAttempts).toBe(2);
    });

    test("stalled single download fails after max retries", async () => {
        process.env["CACHE_S3_DOWNLOAD_TIMEOUT_MS"] = "30";
        let getAttempts = 0;

        mockSend.mockImplementation(async (command, options) => {
            if ("Prefix" in command.input) {
                return {
                    Contents: [
                        {
                            Key: `${command.input.Prefix}`,
                            LastModified: new Date(),
                            Size: 7
                        }
                    ]
                };
            }
            getAttempts++;
            return new Promise((_resolve, reject) => {
                options?.abortSignal?.addEventListener("abort", () => {
                    reject(options.abortSignal?.reason ?? new Error("aborted"));
                });
            });
        });

        const key = await (
            await loadS3Cache()
        ).restoreCache(["/tmp/cached-dir"], "key");

        expect(key).toBeUndefined();
        expect(getAttempts).toBe(3);
        expect(mockWarning).toHaveBeenCalledWith(
            expect.stringContaining("Download timed out after 30ms")
        );
    });

    test("stalled Range download aborts on timeout and succeeds on retry", async () => {
        process.env["CACHE_S3_DOWNLOAD_PART_SIZE"] = "4";
        process.env["CACHE_S3_DOWNLOAD_QUEUE_SIZE"] = "2";
        process.env["CACHE_S3_DOWNLOAD_TIMEOUT_MS"] = "50";
        const fullPayload = Buffer.from("abcdefgh");
        const attemptsByRange: Record<string, number> = {};
        let restoredBytes: Buffer | undefined;

        mockSend.mockImplementation(async command => {
            if ("Prefix" in command.input) {
                return {
                    Contents: [
                        {
                            Key: `${command.input.Prefix}`,
                            LastModified: new Date(),
                            Size: fullPayload.length
                        }
                    ]
                };
            }
            const rangeHeader = command.input.Range as string;
            attemptsByRange[rangeHeader] =
                (attemptsByRange[rangeHeader] ?? 0) + 1;
            const match = /^bytes=(\d+)-(\d+)$/.exec(rangeHeader);
            const start = Number(match![1]);
            const end = Number(match![2]);
            if (
                rangeHeader === "bytes=0-3" &&
                attemptsByRange[rangeHeader] === 1
            ) {
                return {
                    ContentRange: `bytes ${start}-${end}/${fullPayload.length}`,
                    Body: new Readable({
                        read() {
                            // Stall first attempt for range 0-3.
                        }
                    })
                };
            }
            return {
                ContentRange: `bytes ${start}-${end}/${fullPayload.length}`,
                Body: Readable.from([fullPayload.subarray(start, end + 1)])
            };
        });

        mockExec.mockImplementation(
            async (_tool: string, args: string[] = []) => {
                const xfIdx = args.findIndex(arg => /^-x[z]?f$/.test(arg));
                if (xfIdx !== -1) {
                    restoredBytes = await fs.promises.readFile(args[xfIdx + 1]);
                }
                return 0;
            }
        );

        const key = await (
            await loadS3Cache()
        ).restoreCache(["/tmp/cached-dir"], "key");

        expect(key).toBe("key");
        expect(attemptsByRange["bytes=0-3"]).toBe(2);
        expect(attemptsByRange["bytes=4-7"]).toBe(1);
        expect(restoredBytes?.toString()).toBe("abcdefgh");
    });

    test("CACHE_S3_DOWNLOAD_TIMEOUT_MS=2147483648 warns and falls back to 30000 without TimeoutOverflowWarning", async () => {
        process.env["CACHE_S3_DOWNLOAD_TIMEOUT_MS"] = "2147483648";
        const emitWarningSpy = jest.spyOn(process, "emitWarning");
        try {
            mockSend.mockImplementation(async command => {
                if ("Prefix" in command.input) {
                    return {
                        Contents: [
                            {
                                Key: `${command.input.Prefix}`,
                                LastModified: new Date(),
                                Size: 7
                            }
                        ]
                    };
                }
                return {
                    ContentLength: 7,
                    Body: Readable.from([Buffer.from("payload")])
                };
            });

            const s3 = await loadS3Cache();
            expect(mockWarning).toHaveBeenCalledWith(
                expect.stringContaining(
                    'Invalid CACHE_S3_DOWNLOAD_TIMEOUT_MS="2147483648"'
                )
            );
            expect(mockWarning).toHaveBeenCalledWith(
                expect.stringContaining("Falling back to 30000.")
            );

            const key = await s3.restoreCache(["/tmp/cached-dir"], "key");
            expect(key).toBe("key");
            const overflowWarnings = emitWarningSpy.mock.calls.filter(call =>
                String(call[0]).includes("TimeoutOverflowWarning")
            );
            expect(overflowWarnings).toHaveLength(0);
        } finally {
            emitWarningSpy.mockRestore();
        }
    });

    test("Range download ContentRange mismatch with short timeout safely disposes stream without unhandled error and retries cleanly", async () => {
        process.env["CACHE_S3_DOWNLOAD_PART_SIZE"] = "4";
        process.env["CACHE_S3_DOWNLOAD_QUEUE_SIZE"] = "1";
        process.env["CACHE_S3_DOWNLOAD_TIMEOUT_MS"] = "40";
        const fullPayload = Buffer.from("abcdefgh");
        const attemptsByRange: Record<string, number> = {};
        let restoredBytes: Buffer | undefined;

        mockSend.mockImplementation(async command => {
            if ("Prefix" in command.input) {
                return {
                    Contents: [
                        {
                            Key: `${command.input.Prefix}`,
                            LastModified: new Date(),
                            Size: fullPayload.length
                        }
                    ]
                };
            }
            const rangeHeader = command.input.Range as string;
            attemptsByRange[rangeHeader] =
                (attemptsByRange[rangeHeader] ?? 0) + 1;
            const match = /^bytes=(\d+)-(\d+)$/.exec(rangeHeader);
            const start = Number(match![1]);
            const end = Number(match![2]);

            if (
                rangeHeader === "bytes=0-3" &&
                attemptsByRange[rangeHeader] === 1
            ) {
                const unconsumedStream = new Readable({
                    read() {
                        // Never consumed due to ContentRange mismatch.
                    },
                    destroy(_err, cb) {
                        // Simulate ChecksumStream emitting an error on destroy.
                        cb(new Error("checksum stream destroyed early"));
                    }
                });
                return {
                    ContentRange: `bytes 999-1002/${fullPayload.length}`,
                    Body: unconsumedStream
                };
            }
            return {
                ContentRange: `bytes ${start}-${end}/${fullPayload.length}`,
                Body: Readable.from([fullPayload.subarray(start, end + 1)])
            };
        });

        mockExec.mockImplementation(
            async (_tool: string, args: string[] = []) => {
                const xfIdx = args.findIndex(arg => /^-x[z]?f$/.test(arg));
                if (xfIdx !== -1) {
                    restoredBytes = await fs.promises.readFile(args[xfIdx + 1]);
                }
                return 0;
            }
        );

        const key = await (
            await loadS3Cache()
        ).restoreCache(["/tmp/cached-dir"], "key");

        expect(key).toBe("key");
        expect(attemptsByRange["bytes=0-3"]).toBe(2);
        expect(restoredBytes?.toString()).toBe("abcdefgh");
    });
});

describe("S3 transfer progress logging", () => {
    test("saveCache logs uploaded part progress and ignores events without part number", async () => {
        mockUploadOn.mockImplementation((event, listener) => {
            if (event === "httpUploadProgress") {
                mockUploadDone.mockImplementationOnce(async () => {
                    listener({ loaded: 3 });
                    listener({ part: 1, loaded: 7 });
                });
            }
        });

        await (await loadS3Cache()).saveCache(["/tmp/cached-dir"], "my-key");

        expect(mockUploadOn).toHaveBeenCalledWith(
            "httpUploadProgress",
            expect.any(Function)
        );
        expect(mockInfo).toHaveBeenCalledWith("Uploaded part 1/1");
        const partLogs = mockInfo.mock.calls
            .map(call => call[0])
            .filter(msg => msg.startsWith("Uploaded part "));
        expect(partLogs).toEqual(["Uploaded part 1/1"]);
    });

    test("single download logs download progress", async () => {
        const payload = Buffer.from("0123456789");
        mockSend.mockImplementation(async command => {
            if ("Prefix" in command.input) {
                return {
                    Contents: [
                        {
                            Key: `${command.input.Prefix}`,
                            LastModified: new Date(),
                            Size: payload.length
                        }
                    ]
                };
            }
            return {
                ContentLength: payload.length,
                Body: Readable.from([
                    payload.subarray(0, 4),
                    payload.subarray(4)
                ])
            };
        });

        const key = await (
            await loadS3Cache()
        ).restoreCache(["/tmp/cached-dir"], "key");

        expect(key).toBe("key");
        expect(mockInfo).toHaveBeenCalledWith(
            expect.stringMatching(/^Received 10 of 10 \(100\.0%\), .+ MB\/s$/)
        );
    });

    test("concurrent Range download logs download progress", async () => {
        process.env["CACHE_S3_DOWNLOAD_PART_SIZE"] = "4";
        process.env["CACHE_S3_DOWNLOAD_QUEUE_SIZE"] = "2";
        const fullPayload = Buffer.from("0123456789");

        mockSend.mockImplementation(async command => {
            if ("Prefix" in command.input) {
                return {
                    Contents: [
                        {
                            Key: `${command.input.Prefix}`,
                            LastModified: new Date(),
                            Size: fullPayload.length
                        }
                    ]
                };
            }
            const rangeHeader = command.input.Range as string;
            const match = /^bytes=(\d+)-(\d+)$/.exec(rangeHeader);
            const start = Number(match![1]);
            const end = Number(match![2]);
            return {
                ContentRange: `bytes ${start}-${end}/${fullPayload.length}`,
                Body: Readable.from([fullPayload.subarray(start, end + 1)])
            };
        });

        const key = await (
            await loadS3Cache()
        ).restoreCache(["/tmp/cached-dir"], "key");

        expect(key).toBe("key");
        expect(mockInfo).toHaveBeenCalledWith(
            expect.stringMatching(/^Received 10 of 10 \(100\.0%\), .+ MB\/s$/)
        );
    });

    test("DownloadProgress avoids duplicate final display and clamps elapsed time", async () => {
        const { DownloadProgress } = await loadS3Cache();
        const progress = new DownloadProgress(100);
        progress.addBytes(50);
        progress.display();
        progress.stop();

        const receivedLogs = mockInfo.mock.calls
            .map(call => call[0])
            .filter(msg => msg.startsWith("Received "));
        expect(receivedLogs).toHaveLength(1);
        expect(receivedLogs[0]).toMatch(
            /^Received 50 of 100 \(50\.0%\), \d+\.\d MB\/s$/
        );
    });
});

describe("S3 debug archive listing and diagnostics", () => {
    test("lists gzip archive on saveCache and restoreCache when core.isDebug() is true", async () => {
        mockIsDebug.mockReturnValue(true);
        const s3 = await loadS3Cache();

        await s3.saveCache(["/tmp/cached-dir"], "my-key");

        expect(mockDebug).toHaveBeenCalledWith(
            'Cache Paths: ["/tmp/cached-dir"]'
        );
        expect(mockDebug).toHaveBeenCalledWith(
            expect.stringMatching(/^Archive Path: .*cache\.tar\.gz$/)
        );
        expect(mockExec).toHaveBeenCalledTimes(2);
        expect(mockExec.mock.calls[1]).toEqual([
            "tar",
            ["-tzf", expect.stringMatching(/cache\.tar\.gz$/)]
        ]);

        mockExec.mockClear();
        mockDebug.mockClear();
        mockSend.mockImplementation(async command => {
            if ("Prefix" in command.input) {
                return {
                    Contents: [
                        {
                            Key: `${command.input.Prefix}`,
                            LastModified: new Date(),
                            Size: 7
                        }
                    ]
                };
            }
            return {
                ContentLength: 7,
                Body: Readable.from([Buffer.from("payload")])
            };
        });

        const key = await s3.restoreCache(["/tmp/cached-dir"], "my-key", [
            "fallback-"
        ]);

        expect(key).toBe("my-key");
        expect(mockDebug).toHaveBeenCalledWith(
            'Resolved Keys: ["my-key","fallback-"]'
        );
        expect(mockDebug).toHaveBeenCalledWith(
            expect.stringMatching(/^Archive Path: .*cache\.tar\.gz$/)
        );
        expect(mockExec).toHaveBeenCalledTimes(2);
        expect(mockExec.mock.calls[0]).toEqual([
            "tar",
            ["-tzf", expect.stringMatching(/cache\.tar\.gz$/)]
        ]);
        expect(mockExec.mock.calls[1]).toEqual([
            "tar",
            ["-xzf", expect.stringMatching(/cache\.tar\.gz$/), "-C", "/"]
        ]);
    });

    test("lists zstd archive when core.isDebug() is true and skips listing when false", async () => {
        mockAvailableTools("zstd", "unzstd");
        mockIsDebug.mockReturnValue(true);

        await (await loadS3Cache()).saveCache(["/tmp/cached-dir"], "my-key");

        expect(mockExec).toHaveBeenCalledTimes(2);
        expect(mockExec.mock.calls[1]).toEqual([
            "tar",
            [
                "--use-compress-program",
                "unzstd",
                "-tf",
                expect.stringMatching(/cache\.tar\.zst$/)
            ]
        ]);

        mockExec.mockClear();
        mockIsDebug.mockReturnValue(false);

        await (await loadS3Cache()).saveCache(["/tmp/cached-dir"], "my-key");

        expect(mockExec).toHaveBeenCalledTimes(1);
    });

    test("listArchive failure does not abort saveCache upload or restoreCache extraction", async () => {
        mockIsDebug.mockReturnValue(true);
        mockExec.mockImplementation(
            async (_tool: string, args: string[] = []) => {
                const outputIndex = args.findIndex(arg =>
                    /^-c[z]?f$/.test(arg)
                );
                if (outputIndex !== -1) {
                    await fs.promises.writeFile(
                        args[outputIndex + 1],
                        "archive"
                    );
                    return 0;
                }
                if (args.includes("-tzf") || args.includes("-tf")) {
                    throw new Error(
                        "The process '/usr/bin/tar' failed with exit code 2"
                    );
                }
                return 0;
            }
        );

        const s3 = await loadS3Cache();
        await s3.saveCache(["/tmp/cached-dir"], "my-key");

        expect(mockUploadDone).toHaveBeenCalledTimes(1);
        expect(mockDebug).toHaveBeenCalledWith(
            expect.stringContaining("Failed to list archive:")
        );

        mockExec.mockClear();
        mockDebug.mockClear();
        mockSend.mockImplementation(async command => {
            if ("Prefix" in command.input) {
                return {
                    Contents: [
                        {
                            Key: `${command.input.Prefix}`,
                            LastModified: new Date(),
                            Size: 7
                        }
                    ]
                };
            }
            return {
                ContentLength: 7,
                Body: Readable.from([Buffer.from("payload")])
            };
        });

        const key = await s3.restoreCache(["/tmp/cached-dir"], "my-key");

        expect(key).toBe("my-key");
        expect(mockDebug).toHaveBeenCalledWith(
            expect.stringContaining("Failed to list archive:")
        );
        expect(mockExec).toHaveBeenCalledWith("tar", [
            "-xzf",
            expect.stringMatching(/cache\.tar\.gz$/),
            "-C",
            "/"
        ]);
    });
});
