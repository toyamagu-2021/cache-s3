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
    jest.fn<(command: { input: Record<string, string> }) => Promise<unknown>>();
const mockUploadDone = jest.fn<() => Promise<void>>();
const mockUpload = jest.fn<
    (options: {
        params: { Key: string };
        partSize: number;
        queueSize: number;
    }) => { done: () => Promise<void> }
>(() => ({ done: mockUploadDone }));
const mockWarning = jest.fn<(message: string | Error) => void>();
const mockInfo = jest.fn<(message: string) => void>();

jest.unstable_mockModule("@actions/core", () => ({
    warning: mockWarning,
    info: mockInfo
}));
jest.unstable_mockModule("@actions/exec", () => ({ exec: mockExec }));
jest.unstable_mockModule("@actions/io", () => ({ which: mockWhich }));
jest.unstable_mockModule("@actions/glob", () => ({ create: mockGlobCreate }));

jest.unstable_mockModule("@aws-sdk/client-s3", () => ({
    S3Client: jest.fn(() => ({ send: mockSend })),
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
    mockUpload.mockClear();
    mockWarning.mockClear();
    mockInfo.mockClear();
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
    delete process.env["GITHUB_REPOSITORY"];
    delete process.env["CACHE_S3_PREFIX"];
    delete process.env["CACHE_S3_UPLOAD_QUEUE_SIZE"];
    delete process.env["CACHE_S3_UPLOAD_PART_SIZE"];
    delete process.env["CACHE_S3_DOWNLOAD_QUEUE_SIZE"];
    delete process.env["CACHE_S3_DOWNLOAD_PART_SIZE"];
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
