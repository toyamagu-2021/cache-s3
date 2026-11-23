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
const mockS3Client = jest.fn<
    (config: Record<string, unknown>) => { send: typeof mockSend }
>(() => ({ send: mockSend }));
const mockUploadDone = jest.fn<() => Promise<void>>();
const mockUploadOn =
    jest.fn<
        (event: string, listener: (progress: { part?: number }) => void) => void
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
    delete process.env["CACHE_S3_UNSET_AWS_CREDENTIALS"];
    delete process.env["CACHE_S3_FORCE_PATH_STYLE"];
    delete process.env["AWS_S3_FORCE_PATH_STYLE"];
    delete process.env["GITHUB_REPOSITORY"];
    delete process.env["CACHE_S3_PREFIX"];
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

    test("CACHE_S3_UNSET_AWS_CREDENTIALS=true deletes AWS credential env vars while preserving region vars", async () => {
        process.env["CACHE_S3_UNSET_AWS_CREDENTIALS"] = "true";
        process.env["AWS_ACCESS_KEY_ID"] = "AKIAEXAMPLE";
        process.env["AWS_SECRET_ACCESS_KEY"] = "secret";
        process.env["AWS_SESSION_TOKEN"] = "token";
        process.env["AWS_REGION"] = "ap-northeast-1";
        process.env["AWS_DEFAULT_REGION"] = "us-west-2";

        await loadS3Cache();

        expect(process.env["AWS_ACCESS_KEY_ID"]).toBeUndefined();
        expect(process.env["AWS_SECRET_ACCESS_KEY"]).toBeUndefined();
        expect(process.env["AWS_SESSION_TOKEN"]).toBeUndefined();
        expect(process.env["AWS_REGION"]).toBe("ap-northeast-1");
        expect(process.env["AWS_DEFAULT_REGION"]).toBe("us-west-2");
    });

    test("leaves AWS credential env vars intact when CACHE_S3_UNSET_AWS_CREDENTIALS is unset or false", async () => {
        process.env["AWS_ACCESS_KEY_ID"] = "AKIAEXAMPLE";
        process.env["AWS_SECRET_ACCESS_KEY"] = "secret";
        process.env["AWS_SESSION_TOKEN"] = "token";

        await loadS3Cache();

        expect(process.env["AWS_ACCESS_KEY_ID"]).toBe("AKIAEXAMPLE");
        expect(process.env["AWS_SECRET_ACCESS_KEY"]).toBe("secret");
        expect(process.env["AWS_SESSION_TOKEN"]).toBe("token");

        process.env["CACHE_S3_UNSET_AWS_CREDENTIALS"] = "false";
        await loadS3Cache();

        expect(process.env["AWS_ACCESS_KEY_ID"]).toBe("AKIAEXAMPLE");
        expect(process.env["AWS_SECRET_ACCESS_KEY"]).toBe("secret");
        expect(process.env["AWS_SESSION_TOKEN"]).toBe("token");
    });

    test("AWS_S3_FORCE_PATH_STYLE=true enables forcePathStyle on S3Client", async () => {
        process.env["AWS_S3_FORCE_PATH_STYLE"] = "true";

        await loadS3Cache();

        expect(mockS3Client).toHaveBeenCalledWith(
            expect.objectContaining({ forcePathStyle: true })
        );
    });
});

describe("download timeouts", () => {
    function stalledReadable(): Readable {
        return new Readable({
            read() {
                // Intentionally never pushes data or ends
            }
        });
    }

    test("aborts a stalled single-object download after CACHE_S3_DOWNLOAD_TIMEOUT_MS and succeeds on retry", async () => {
        process.env["CACHE_S3_DOWNLOAD_TIMEOUT_MS"] = "50";
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
                    return { Body: stalledReadable() };
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

    test("returns undefined when single-object download times out across all retries", async () => {
        process.env["CACHE_S3_DOWNLOAD_TIMEOUT_MS"] = "30";
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
                return { Body: stalledReadable() };
            }
        );

        const key = await (
            await loadS3Cache()
        ).restoreCache(["/tmp/cached-dir"], "key");

        expect(key).toBeUndefined();
        expect(getAttempts).toBe(3);
        expect(mockExec).not.toHaveBeenCalled();
        expect(mockWarning).toHaveBeenCalledWith(
            expect.stringContaining("Failed to restore cache:")
        );
    });

    test("aborts a stalled Range download after CACHE_S3_DOWNLOAD_TIMEOUT_MS and succeeds on retry", async () => {
        process.env["CACHE_S3_DOWNLOAD_PART_SIZE"] = "4";
        process.env["CACHE_S3_DOWNLOAD_QUEUE_SIZE"] = "2";
        process.env["CACHE_S3_DOWNLOAD_TIMEOUT_MS"] = "50";

        const fullPayload = Buffer.from("01234567");
        const rangeCalls: Record<string, number> = {};
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

                if (
                    rangeHeader === "bytes=0-3" &&
                    rangeCalls[rangeHeader] === 1
                ) {
                    return {
                        ContentRange: `bytes 0-3/${fullPayload.length}`,
                        Body: stalledReadable()
                    };
                }

                const match = /^bytes=(\d+)-(\d+)$/.exec(rangeHeader);
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
        expect(rangeCalls).toEqual({
            "bytes=0-3": 2,
            "bytes=4-7": 1
        });
        expect(restoredBytes?.toString()).toBe("01234567");
    });

    test("returns undefined when a Range download times out across all retries", async () => {
        process.env["CACHE_S3_DOWNLOAD_PART_SIZE"] = "4";
        process.env["CACHE_S3_DOWNLOAD_QUEUE_SIZE"] = "2";
        process.env["CACHE_S3_DOWNLOAD_TIMEOUT_MS"] = "30";

        let stalledAttempts = 0;
        mockSend.mockImplementation(
            async (command: { input: Record<string, unknown> }) => {
                if ("Prefix" in command.input) {
                    return {
                        Contents: [
                            {
                                Key: command.input.Prefix,
                                LastModified: new Date(),
                                Size: 8
                            }
                        ]
                    };
                }
                const rangeHeader = command.input.Range as string;
                if (rangeHeader === "bytes=0-3") {
                    stalledAttempts++;
                    return {
                        ContentRange: "bytes 0-3/8",
                        Body: stalledReadable()
                    };
                }
                return {
                    ContentRange: "bytes 4-7/8",
                    Body: Readable.from([Buffer.from("4567")])
                };
            }
        );

        const key = await (
            await loadS3Cache()
        ).restoreCache(["/tmp/cached-dir"], "key");

        expect(key).toBeUndefined();
        expect(stalledAttempts).toBe(3);
        expect(mockExec).not.toHaveBeenCalled();
        expect(mockWarning).toHaveBeenCalledWith(
            expect.stringContaining("timed out")
        );
    });
});

describe("transfer progress logging", () => {
    test("logs uploaded part progress from httpUploadProgress events", async () => {
        mockUploadOn.mockImplementation((event, listener) => {
            if (event === "httpUploadProgress") {
                listener({});
                listener({ part: 1 });
            }
        });

        await (await loadS3Cache()).saveCache(["/tmp/cached-dir"], "key");

        expect(mockUploadOn).toHaveBeenCalledWith(
            "httpUploadProgress",
            expect.any(Function)
        );
        expect(mockInfo).toHaveBeenCalledWith("Uploaded part 1/1");
    });

    test("logs download progress for single-object and Range downloads without NaN or Infinity", async () => {
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
                return { Body: Readable.from(["archive"]) };
            }
        );

        await (await loadS3Cache()).restoreCache(["/tmp/cached-dir"], "key");

        const singleProgressLogs = mockInfo.mock.calls
            .map(call => call[0])
            .filter(msg => msg.startsWith("Received "));
        expect(singleProgressLogs).toHaveLength(1);
        expect(singleProgressLogs[0]).toMatch(
            /^Received 7 of 7 \(100\.0%\), \d+\.\d MB\/s$/
        );

        mockInfo.mockClear();
        process.env["CACHE_S3_DOWNLOAD_PART_SIZE"] = "4";
        mockSend.mockImplementation(
            async (command: { input: Record<string, unknown> }) => {
                if ("Prefix" in command.input) {
                    return {
                        Contents: [
                            {
                                Key: command.input.Prefix,
                                LastModified: new Date(),
                                Size: 8
                            }
                        ]
                    };
                }
                const rangeHeader = command.input.Range as string;
                const match = /^bytes=(\d+)-(\d+)$/.exec(rangeHeader);
                const start = Number(match![1]);
                const end = Number(match![2]);
                const payload = Buffer.from("01234567");
                return {
                    ContentRange: `bytes ${start}-${end}/8`,
                    Body: Readable.from([payload.subarray(start, end + 1)])
                };
            }
        );

        await (await loadS3Cache()).restoreCache(["/tmp/cached-dir"], "key");

        const rangeProgressLogs = mockInfo.mock.calls
            .map(call => call[0])
            .filter(msg => msg.startsWith("Received "));
        expect(rangeProgressLogs).toHaveLength(1);
        expect(rangeProgressLogs[0]).toMatch(
            /^Received 8 of 8 \(100\.0%\), \d+\.\d MB\/s$/
        );
    });
});

describe("debug archive listing and diagnostics", () => {
    test("lists gzip archive in saveCache and restoreCache when core.isDebug() is true", async () => {
        mockIsDebug.mockReturnValue(true);

        const s3 = await loadS3Cache();
        await s3.saveCache(["/tmp/cached-dir"], "key");

        expect(mockExec).toHaveBeenCalledTimes(2);
        expect(mockExec.mock.calls[0][1]?.[0]).toBe("-czf");
        expect(mockExec.mock.calls[1]).toEqual([
            "tar",
            ["-tzf", expect.stringMatching(/cache\.tar\.gz$/)]
        ]);
        expect(mockDebug).toHaveBeenCalledWith(
            expect.stringContaining("Cache Paths:")
        );
        expect(mockDebug).toHaveBeenCalledWith(
            expect.stringContaining("Archive Path:")
        );

        mockExec.mockClear();
        mockDebug.mockClear();
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
                return { Body: Readable.from(["archive"]) };
            }
        );

        await s3.restoreCache(["/tmp/cached-dir"], "key");

        expect(mockExec).toHaveBeenCalledTimes(2);
        expect(mockExec.mock.calls[0]).toEqual([
            "tar",
            ["-tzf", expect.stringMatching(/cache\.tar\.gz$/)]
        ]);
        expect(mockExec.mock.calls[1][1]?.[0]).toBe("-xzf");
        expect(mockDebug).toHaveBeenCalledWith(
            expect.stringContaining("Resolved Keys:")
        );
        expect(mockDebug).toHaveBeenCalledWith(
            expect.stringContaining("Archive Path:")
        );
    });

    test("lists zstd archive with decompress program when core.isDebug() is true", async () => {
        mockIsDebug.mockReturnValue(true);
        mockAvailableTools("zstd", "unzstd");

        const s3 = await loadS3Cache();
        await s3.saveCache(["/tmp/cached-dir"], "key");

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
                return { Body: Readable.from(["archive"]) };
            }
        );

        await s3.restoreCache(["/tmp/cached-dir"], "key");

        expect(mockExec).toHaveBeenCalledTimes(2);
        expect(mockExec.mock.calls[0]).toEqual([
            "tar",
            [
                "--use-compress-program",
                "unzstd",
                "-tf",
                expect.stringMatching(/cache\.tar\.zst$/)
            ]
        ]);
        expect(mockExec.mock.calls[1][1]?.[2]).toBe("-xf");
    });

    test("does not list archive when core.isDebug() is false", async () => {
        mockIsDebug.mockReturnValue(false);
        const s3 = await loadS3Cache();

        await s3.saveCache(["/tmp/cached-dir"], "key");
        expect(mockExec).toHaveBeenCalledTimes(1);

        mockExec.mockClear();
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
                return { Body: Readable.from(["archive"]) };
            }
        );

        await s3.restoreCache(["/tmp/cached-dir"], "key");
        expect(mockExec).toHaveBeenCalledTimes(1);
    });
});
