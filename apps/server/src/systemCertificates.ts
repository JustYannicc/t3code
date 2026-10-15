// @effect-diagnostics nodeBuiltinImport:off
// CA trust is process-wide Node TLS state, set at startup before the Effect
// runtime opens any connection.
import * as NodeTls from "node:tls";

export interface CaCertificateStore {
  readonly getCACertificates: (typeof NodeTls)["getCACertificates"];
  // Optional because Node only added it in 22.19 and 24.5.
  readonly setDefaultCACertificates?: (typeof NodeTls)["setDefaultCACertificates"] | undefined;
}

/**
 * Adds the OS certificate store to the CAs Node trusts by default, keeping the
 * bundled roots and any `NODE_EXTRA_CA_CERTS`. Without it, server-side requests
 * fail behind a private CA or TLS-inspecting proxy that the OS, browsers, curl
 * and `gh` already trust. Runtimes without the API, or with an empty or
 * unreadable OS store, keep Node's defaults.
 *
 * Node deduplicates the combined list, so overlapping roots are harmless.
 * Returns whether the OS store was added.
 */
export function trustSystemCertificates(tls: CaCertificateStore = NodeTls): boolean {
  if (typeof tls.setDefaultCACertificates !== "function") return false;
  try {
    const system = tls.getCACertificates("system");
    if (system.length === 0) return false;
    tls.setDefaultCACertificates([...tls.getCACertificates("default"), ...system]);
    return true;
  } catch {
    return false;
  }
}
