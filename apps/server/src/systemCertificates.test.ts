import { describe, expect, it } from "vite-plus/test";

import { type CaCertificateStore, trustSystemCertificates } from "./systemCertificates.ts";

const BUNDLED = "bundled-root";
const EXTRA = "node-extra-ca-root";
const CORPORATE = "corporate-proxy-root";

const makeStore = (sources: { default: string[]; system: () => string[] }) => {
  let defaults = sources.default;
  const store = {
    getCACertificates: (type?: "default" | "system" | "bundled" | "extra") =>
      type === "system" ? sources.system() : defaults,
    setDefaultCACertificates: (certs: ReadonlyArray<string | NodeJS.ArrayBufferView>) => {
      defaults = certs.map(String);
    },
  } satisfies CaCertificateStore;
  return { store, defaults: () => defaults };
};

describe("trustSystemCertificates", () => {
  it("adds the OS store to the bundled and NODE_EXTRA_CA_CERTS roots", () => {
    const { store, defaults } = makeStore({
      default: [BUNDLED, EXTRA],
      system: () => [BUNDLED, CORPORATE],
    });

    expect(trustSystemCertificates(store)).toBe(true);
    expect(defaults()).toEqual([BUNDLED, EXTRA, BUNDLED, CORPORATE]);
  });

  it("keeps the defaults on runtimes without setDefaultCACertificates", () => {
    const { store, defaults } = makeStore({
      default: [BUNDLED],
      system: () => [CORPORATE],
    });

    expect(trustSystemCertificates({ ...store, setDefaultCACertificates: undefined })).toBe(false);
    expect(defaults()).toEqual([BUNDLED]);
  });

  it("keeps the defaults when the OS store is empty", () => {
    const { store, defaults } = makeStore({ default: [BUNDLED], system: () => [] });

    expect(trustSystemCertificates(store)).toBe(false);
    expect(defaults()).toEqual([BUNDLED]);
  });

  it("keeps the defaults when the OS store cannot be read", () => {
    const { store, defaults } = makeStore({
      default: [BUNDLED],
      system: () => {
        throw new Error("keychain unavailable");
      },
    });

    expect(trustSystemCertificates(store)).toBe(false);
    expect(defaults()).toEqual([BUNDLED]);
  });
});
