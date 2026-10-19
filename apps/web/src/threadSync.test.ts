import { describe, expect, it } from "vite-plus/test";

import { resolveThreadSyncPhase, threadSyncLabel } from "./threadSync";

describe("resolveThreadSyncPhase", () => {
  it("loads when only shell data is available", () => {
    expect(
      resolveThreadSyncPhase({
        detailExists: false,
        shellExists: true,
        status: "synchronizing",
      }),
    ).toBe("loading");
  });

  it("stops syncing cached detail on terminal error and resumes when recovery clears it", () => {
    const cachedDetail = {
      detailExists: true,
      shellExists: true,
      status: "cached" as const,
      detailError: null,
    };
    expect(resolveThreadSyncPhase(cachedDetail)).toBe("syncing");

    const failedDetail = {
      ...cachedDetail,
      detailError:
        "Message synchronization timed out. Reconnect or return to the app to try again.",
    };
    expect.soft(resolveThreadSyncPhase(failedDetail)).toBeNull();

    const recoveringDetail = {
      ...failedDetail,
      status: "synchronizing" as const,
      detailError: null,
    };
    expect(resolveThreadSyncPhase(recoveringDetail)).toBe("syncing");
  });

  it("does not report a sync phase without a shell or after going live", () => {
    expect(
      resolveThreadSyncPhase({
        detailExists: false,
        shellExists: false,
        status: "empty",
      }),
    ).toBeNull();
    expect(
      resolveThreadSyncPhase({
        detailExists: true,
        shellExists: true,
        status: "live",
      }),
    ).toBeNull();
  });
});

describe("threadSyncLabel", () => {
  it("uses the same loading and syncing language as mobile", () => {
    expect(threadSyncLabel("loading")).toBe("Loading messages...");
    expect(threadSyncLabel("syncing")).toBe("Syncing messages...");
  });
});
