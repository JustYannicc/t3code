// @effect-diagnostics nodeBuiltinImport:off
import * as NodeTls from "node:tls";

export interface CaCertificateStore {
  readonly getCACertificates: (typeof NodeTls)["getCACertificates"];
  readonly setDefaultCACertificates?: (typeof NodeTls)["setDefaultCACertificates"] | undefined;
}

/** Adds OS roots to Node's defaults without dropping bundled or extra roots. */
export function trustSystemCertificates(tls: CaCertificateStore = NodeTls): boolean {
  try {
    if (typeof tls.setDefaultCACertificates !== "function") return false;
    const system = tls.getCACertificates("system");
    if (system.length === 0) return false;
    tls.setDefaultCACertificates([...new Set([...tls.getCACertificates("default"), ...system])]);
    return true;
  } catch {
    return false;
  }
}
