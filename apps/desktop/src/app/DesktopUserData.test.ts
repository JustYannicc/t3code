import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import { resolveUserDataPath } from "./DesktopUserData.ts";

it.effect.each([true, false])(
  "isolates local macOS browser profiles without copying shared data (development: %s)",
  (isDevelopment) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mac-profile-" });
      const legacy = path.join(directory, isDevelopment ? "T3 Code (Dev)" : "t3code-v2");
      yield* fs.makeDirectory(legacy, { recursive: true });
      yield* fs.writeFileString(path.join(legacy, "Cookies"), "shared encrypted cookies");
      const input = {
        appDataDirectory: directory,
        platform: "darwin",
        isPackaged: false,
        isDevelopment,
      } as const;
      const a = yield* resolveUserDataPath({ ...input, dirname: "/runtime/a" });
      const b = yield* resolveUserDataPath({ ...input, dirname: "/runtime/b" });
      assert.notEqual(a, b);
      assert.notEqual(a, legacy);
      yield* fs.makeDirectory(a, { recursive: true });
      yield* fs.writeFileString(path.join(a, "Cookies"), "runtime A cookies");
      assert.isFalse(yield* fs.exists(path.join(b, "Cookies")));
      assert.equal(yield* resolveUserDataPath({ ...input, dirname: "/runtime/a/./" }), a);
      assert.equal(yield* fs.readFileString(path.join(a, "Cookies")), "runtime A cookies");
      assert.equal(
        yield* fs.readFileString(path.join(legacy, "Cookies")),
        "shared encrypted cookies",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("identifies a failed source read and preserves its cause", () => {
  const sourceState = "/profiles/t3code/Local State";
  const cause = PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "FileSystem",
    method: "readFileString",
    pathOrDescriptor: sourceState,
  });
  return Effect.gen(function* () {
    const error = yield* resolveUserDataPath({
      appDataDirectory: "/profiles",
      isDevelopment: false,
      platform: "win32",
      isPackaged: true,
      dirname: "/app",
    }).pipe(Effect.flip);
    assert.equal(error.operation, "read");
    assert.equal(error.resourcePath, sourceState);
    assert.equal(error.category, "PermissionDenied");
    assert.strictEqual(error.cause, cause);
  }).pipe(
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        exists: (path) => Effect.succeed(path === sourceState),
        readFileString: () => Effect.fail(cause),
      }),
    ),
    Effect.provide(NodeServices.layer),
  );
});

it.effect.each(["t3code", "T3 Code (Alpha)"])(
  "preserves Windows credential keys from %s without copying browser databases",
  (sourceName) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-v2-profile-" });
      const source = path.join(directory, sourceName);
      const destination = path.join(directory, "t3code-v2");
      const state = '{"os_crypt":{"encrypted_key":"test-encrypted-key"}}';
      yield* fs.makeDirectory(path.join(directory, "T3 Code (Alpha)"), { recursive: true });
      yield* fs.makeDirectory(path.join(source, "IndexedDB"), { recursive: true });
      yield* fs.writeFileString(path.join(source, "Local State"), state);
      yield* fs.writeFileString(path.join(source, "IndexedDB", "LOCK"), "V1 owns this database");
      yield* resolveUserDataPath({
        appDataDirectory: directory,
        isDevelopment: false,
        platform: "win32",
        isPackaged: true,
        dirname: "/app",
      });
      assert.equal(yield* fs.readFileString(path.join(destination, "Local State")), state);
      assert.equal(yield* fs.readFileString(path.join(source, "Local State")), state);
      assert.isFalse(yield* fs.exists(path.join(destination, "IndexedDB")));
      yield* fs.writeFileString(path.join(destination, "Local State"), "existing V2 state");
      yield* resolveUserDataPath({
        appDataDirectory: directory,
        isDevelopment: false,
        platform: "win32",
        isPackaged: true,
        dirname: "/app",
      });
      assert.equal(
        yield* fs.readFileString(path.join(destination, "Local State")),
        "existing V2 state",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
