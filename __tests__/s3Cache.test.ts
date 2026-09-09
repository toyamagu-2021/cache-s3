import * as fs from "fs";
import { Readable } from "stream";

const mockExec = jest.fn();
const mockWhich = jest.fn();
const mockGlobCreate = jest.fn();
const mockSend = jest.fn();
const mockUploadDone = jest.fn();

jest.mock("@actions/exec", () => ({ exec: mockExec }));
jest.mock("@actions/io", () => ({ which: mockWhich }));
jest.mock("@actions/glob", () => ({ create: mockGlobCreate }));

jest.mock("@aws-sdk/client-s3", () => ({
    S3Client: jest.fn(() => ({ send: mockSend })),
    ListObjectsV2Command: jest.fn(input => ({ input })),
    GetObjectCommand: jest.fn(input => ({ input }))
}));

jest.mock("@aws-sdk/lib-storage", () => ({
    Upload: jest.fn(() => ({ done: mockUploadDone }))
}));

type S3CacheModule = typeof import("../src/s3/s3Cache");

// bucketName and the S3 client are captured at module load, so the module has
// to be evaluated after the env vars are in place.
function loadS3Cache(): S3CacheModule {
    let s3Cache: S3CacheModule | undefined;
    jest.isolateModules(() => {
        s3Cache = jest.requireActual<S3CacheModule>("../src/s3/s3Cache");
    });
    return s3Cache as S3CacheModule;
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
    return mockExec.mock.calls[0][1];
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
});

describe("saveCache", () => {
    test("hands directories to tar instead of expanding them into descendants", async () => {
        await loadS3Cache().saveCache(["/tmp/cached-dir"], "key");

        expect(mockGlobCreate).toHaveBeenCalledWith("/tmp/cached-dir", {
            implicitDescendants: false
        });
    });

    test("compresses with a single-pass tar pipeline when zstd is available", async () => {
        mockAvailableTools("zstd", "unzstd");

        await loadS3Cache().saveCache(["/tmp/cached-dir"], "key");

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
        await loadS3Cache().saveCache(["/tmp/cached-dir"], "key");

        const args = tarArgs();
        expect(args[0]).toBe("-czf");
        expect(args[1]).toMatch(/cache\.tar\.gz$/);
        expect(args.slice(2)).toEqual(["-T", `${args[1]}.manifest`]);
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

        const key = await loadS3Cache().restoreCache(
            ["/tmp/cached-dir"],
            "key"
        );

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

        const key = await loadS3Cache().restoreCache(
            ["/tmp/cached-dir"],
            "key"
        );

        expect(key).toBe("key");
        expect(tarArgs().slice(0, 2)).toEqual([
            "--use-compress-program",
            "zstd -d"
        ]);
    });

    test("extracts in one pass with gzip when zstd is unavailable", async () => {
        const key = await loadS3Cache().restoreCache(
            ["/tmp/cached-dir"],
            "key"
        );

        expect(key).toBe("key");
        expect(tarArgs()).toEqual([
            "-xzf",
            expect.stringMatching(/cache\.tar\.gz$/),
            "-C",
            "/"
        ]);
    });
});
