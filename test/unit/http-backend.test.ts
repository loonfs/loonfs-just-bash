import { LoonFSError } from "@loonfs/sdk";
import type { LoonFSClient } from "@loonfs/sdk";
import { describe, expect, it } from "vitest";
import { HttpLoonFsBackend, LoonFsBackendError } from "../../src/index.js";
import type { MutationCommit } from "../../src/index.js";

const commit: MutationCommit = {
  commitId: "c_fixed",
  actor: { kind: "service", id: "agent_test" },
  message: "test",
};

function backendWith(overrides: Record<string, unknown>): HttpLoonFsBackend {
  const client = {
    filesystem: {},
    namespaces: {},
    query: {},
    ...overrides,
  } as unknown as LoonFSClient;
  return new HttpLoonFsBackend({ client, namespaceId: "ns_test" });
}

async function condition(run: Promise<unknown>): Promise<string> {
  try {
    await run;
    return "ok";
  } catch (error) {
    if (error instanceof LoonFsBackendError) {
      return error.code;
    }
    throw error;
  }
}

describe("HttpLoonFsBackend", () => {
  it("retries a lost commit outcome once with the same commit identity", async () => {
    const seen: string[] = [];
    let failed = false;
    const backend = backendWith({
      filesystem: {
        createCommit: async (request: { commit_id: string }) => {
          seen.push(request.commit_id);
          if (!failed) {
            failed = true;
            throw new TypeError("fetch failed");
          }
          return { namespace_id: "ns_test", commit_id: request.commit_id, committed_seq: 7 };
        },
      },
    });
    const receipt = await backend.createDirectory("/made", { parents: false, commit });
    expect(receipt.headSeq).toBe(7);
    expect(seen).toEqual(["c_fixed", "c_fixed"]);
  });

  it("does not retry a guard conflict", async () => {
    let calls = 0;
    const backend = backendWith({
      filesystem: {
        createCommit: async () => {
          calls += 1;
          throw new LoonFSError({
            message: "conflict",
            statusCode: 409,
            body: { code: "stale_revision", message: "changed", request_id: "req_1" },
          });
        },
      },
    });
    const error = await condition(backend.createDirectory("/made", { parents: false, commit }));
    expect(error).toBe("stale_revision");
    expect(calls).toBe(1);
  });

  it("maps server codes to port conditions with the request id kept", async () => {
    const cases: Array<[number, string, string]> = [
      [404, "path_not_found", "not_found"],
      [409, "path_conflict", "destination_exists"],
      [409, "directory_not_empty", "directory_not_empty"],
      [401, "unauthorized", "unauthenticated"],
      [503, "shutting_down", "busy"],
      [501, "not_supported", "unsupported"],
    ];
    for (const [statusCode, code, expected] of cases) {
      const backend = backendWith({
        filesystem: {
          getPathEntry: async () => {
            throw new LoonFSError({ message: code, statusCode, body: { code, message: code, request_id: "req_9" } });
          },
        },
      });
      const error = await backend.stat("/x").catch((e: LoonFsBackendError) => e);
      expect(error).toBeInstanceOf(LoonFsBackendError);
      expect((error as LoonFsBackendError).code, code).toBe(expected);
      expect((error as LoonFsBackendError).requestId).toBe("req_9");
    }
  });

  it("maps unknown statuses and transport loss without leaking internals", async () => {
    const backend = backendWith({
      filesystem: {
        getPathEntry: async () => {
          throw new LoonFSError({ message: "bad gateway", statusCode: 502, body: {} });
        },
      },
      namespaces: {
        getNamespace: async () => {
          throw new TypeError("fetch failed: ECONNREFUSED 127.0.0.1:1");
        },
      },
    });
    expect(await condition(backend.stat("/x"))).toBe("busy");
    const transport = await backend.getNamespace().catch((e: LoonFsBackendError) => e);
    expect((transport as LoonFsBackendError).code).toBe("busy");
    expect((transport as LoonFsBackendError).message).not.toContain("ECONNREFUSED");
  });
});
