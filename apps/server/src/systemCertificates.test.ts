import { describe, expect, it } from "vite-plus/test";

import { type CaCertificateStore, trustSystemCertificates } from "./systemCertificates.ts";

const BUNDLED = "bundled-root";
const EXTRA = "node-extra-ca-root";
const SYSTEM = "system-root";

const makeStore = (sources: { default: string[]; system: () => string[] }) => {
  let defaults = sources.default;
  const store = {
    getCACertificates: (type?: "default" | "system" | "bundled" | "extra") =>
      type === "system" ? sources.system() : defaults,
    setDefaultCACertificates: (certificates: ReadonlyArray<string | NodeJS.ArrayBufferView>) => {
      defaults = certificates.map(String);
    },
  } satisfies CaCertificateStore;
  return { store, defaults: () => defaults };
};

describe("trustSystemCertificates", () => {
  it("adds system roots and keeps bundled and extra roots", () => {
    const { store, defaults } = makeStore({
      default: [BUNDLED, EXTRA],
      system: () => [BUNDLED, SYSTEM],
    });

    expect(trustSystemCertificates(store)).toBe(true);
    expect(defaults()).toEqual([BUNDLED, EXTRA, SYSTEM]);
  });

  it("keeps the defaults when setDefaultCACertificates is missing", () => {
    const { store, defaults } = makeStore({ default: [BUNDLED], system: () => [SYSTEM] });

    expect(trustSystemCertificates({ ...store, setDefaultCACertificates: undefined })).toBe(false);
    expect(defaults()).toEqual([BUNDLED]);
  });

  it("keeps the defaults when the system store is empty", () => {
    const { store, defaults } = makeStore({ default: [BUNDLED], system: () => [] });

    expect(trustSystemCertificates(store)).toBe(false);
    expect(defaults()).toEqual([BUNDLED]);
  });

  it("keeps the defaults when the system store cannot be read", () => {
    const { store, defaults } = makeStore({
      default: [BUNDLED],
      system: () => {
        throw new Error("system store unavailable");
      },
    });

    expect(trustSystemCertificates(store)).toBe(false);
    expect(defaults()).toEqual([BUNDLED]);
  });

  it("keeps the defaults when the current defaults cannot be read", () => {
    const { store, defaults } = makeStore({ default: [BUNDLED], system: () => [SYSTEM] });
    const unreadable = {
      ...store,
      getCACertificates: (type?: "default" | "system" | "bundled" | "extra") => {
        if (type === "system") return [SYSTEM];
        throw new Error("default store unavailable");
      },
    } satisfies CaCertificateStore;

    expect(trustSystemCertificates(unreadable)).toBe(false);
    expect(defaults()).toEqual([BUNDLED]);
  });

  it("keeps the defaults when the setter throws", () => {
    const { store, defaults } = makeStore({ default: [BUNDLED], system: () => [SYSTEM] });
    const unwritable = {
      ...store,
      setDefaultCACertificates: () => {
        throw new Error("default store is read-only");
      },
    } satisfies CaCertificateStore;

    expect(trustSystemCertificates(unwritable)).toBe(false);
    expect(defaults()).toEqual([BUNDLED]);
  });
});
