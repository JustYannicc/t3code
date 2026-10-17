import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import { assert, describe, it } from "@effect/vitest";
import { beforeEach, vi } from "vite-plus/test";

import * as ElectronSafeStorage from "./ElectronSafeStorage.ts";

const { storage } = vi.hoisted(() => ({
  storage: {
    isEncryptionAvailable: vi.fn(),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
    isAsyncEncryptionAvailable: vi.fn<() => Promise<boolean>>(),
    encryptStringAsync: vi.fn<(value: string) => Promise<Buffer>>(),
    decryptStringAsync:
      vi.fn<(value: Buffer) => Promise<{ result: string; shouldReEncrypt: boolean }>>(),
    getSelectedStorageBackend: vi.fn(),
  },
}));

vi.mock("electron", () => ({ safeStorage: storage }));

const withStorage = <A, E>(
  platform: NodeJS.Platform,
  use: (storage: ElectronSafeStorage.ElectronSafeStorage["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.flatMap(ElectronSafeStorage.ElectronSafeStorage, use).pipe(
    Effect.provide(
      ElectronSafeStorage.layer.pipe(Layer.provide(Layer.succeed(HostProcess.Platform, platform))),
    ),
  );

beforeEach(() => vi.resetAllMocks());

describe("macOS safe storage", () => {
  beforeEach(() => {
    for (const method of [
      storage.isEncryptionAvailable,
      storage.encryptString,
      storage.decryptString,
    ]) {
      method.mockImplementation(() => {
        throw new Error("Synchronous Keychain access can block the main thread");
      });
    }
  });

  it.effect("round trips bytes through native async storage and unwraps the decrypt result", () =>
    withStorage("darwin", (safeStorage) =>
      Effect.gen(function* () {
        const encrypted = Buffer.from([0, 128, 255]);
        storage.isAsyncEncryptionAvailable.mockResolvedValue(true);
        storage.encryptStringAsync.mockResolvedValue(encrypted);
        storage.decryptStringAsync.mockResolvedValue({ result: "secret", shouldReEncrypt: true });

        assert.isTrue(yield* safeStorage.isEncryptionAvailable);
        const bytes = yield* safeStorage.encryptString("secret");
        assert.equal(yield* safeStorage.decryptString(new Uint8Array(bytes)), "secret");
        assert.deepEqual(storage.encryptStringAsync.mock.calls, [["secret"]]);
        assert.deepEqual(storage.decryptStringAsync.mock.calls, [[encrypted]]);
        assert.isTrue(Buffer.isBuffer(storage.decryptStringAsync.mock.calls[0]?.[0]));
        assert.isTrue(Option.isNone(yield* safeStorage.selectedStorageBackend));
        assert.lengthOf(storage.getSelectedStorageBackend.mock.calls, 0);
      }),
    ),
  );

  it.effect("waits for native availability without blocking other main-thread work", () =>
    withStorage("darwin", (safeStorage) =>
      Effect.gen(function* () {
        const pending = Promise.withResolvers<boolean>();
        storage.isAsyncEncryptionAvailable.mockReturnValue(pending.promise);
        const result = yield* Effect.forkChild(safeStorage.isEncryptionAvailable);
        // The event loop must keep running while native Keychain consent is pending.
        yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
        assert.lengthOf(storage.isAsyncEncryptionAvailable.mock.calls, 1);
        assert.isUndefined(result.pollUnsafe());
        pending.resolve(false);
        assert.isFalse(yield* Fiber.join(result));
        assert.lengthOf(storage.isEncryptionAvailable.mock.calls, 0);
      }),
    ),
  );

  it.effect("preserves typed errors and causes from native promise rejections", () =>
    withStorage("darwin", (safeStorage) =>
      Effect.gen(function* () {
        const cause = new Error("Keychain denied access");
        storage.isAsyncEncryptionAvailable.mockRejectedValue(cause);
        storage.encryptStringAsync.mockRejectedValue(cause);
        storage.decryptStringAsync.mockRejectedValue(cause);
        const errors = yield* Effect.all([
          Effect.flip(safeStorage.isEncryptionAvailable),
          Effect.flip(safeStorage.encryptString("secret")),
          Effect.flip(safeStorage.decryptString(new Uint8Array([1]))),
        ]);
        assert.instanceOf(errors[0], ElectronSafeStorage.ElectronSafeStorageAvailabilityError);
        assert.instanceOf(errors[1], ElectronSafeStorage.ElectronSafeStorageEncryptError);
        assert.instanceOf(errors[2], ElectronSafeStorage.ElectronSafeStorageDecryptError);
        for (const error of errors) assert.strictEqual(error.cause, cause);
      }),
    ),
  );
});

describe.each(["linux", "win32"] as const)("%s safe storage", (platform) => {
  it.effect("keeps using the existing synchronous backend", () =>
    withStorage(platform, (safeStorage) =>
      Effect.gen(function* () {
        const encrypted = Buffer.from([0, 128, 255]);
        storage.isEncryptionAvailable.mockReturnValue(true);
        storage.encryptString.mockReturnValue(encrypted);
        storage.decryptString.mockReturnValue("secret");
        storage.getSelectedStorageBackend.mockReturnValue("gnome_libsecret");

        assert.isTrue(yield* safeStorage.isEncryptionAvailable);
        assert.deepEqual(yield* safeStorage.encryptString("secret"), encrypted);
        assert.equal(yield* safeStorage.decryptString(new Uint8Array(encrypted)), "secret");
        assert.deepEqual(
          yield* safeStorage.selectedStorageBackend,
          platform === "linux" ? Option.some("gnome_libsecret") : Option.none(),
        );
        assert.lengthOf(storage.isAsyncEncryptionAvailable.mock.calls, 0);
        assert.lengthOf(storage.encryptStringAsync.mock.calls, 0);
        assert.lengthOf(storage.decryptStringAsync.mock.calls, 0);
      }),
    ),
  );
});
