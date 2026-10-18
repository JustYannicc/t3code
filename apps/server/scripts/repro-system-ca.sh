#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp "$repo_root/apps/server/src/systemCertificates.ts" "$work/systemCertificates.ts"

cat > "$work/inside.sh" <<'INSIDE'
set -euo pipefail
work="$(mktemp -d)"
server_pid=""
cleanup() {
  if [ -n "$server_pid" ]; then kill "$server_pid" 2>/dev/null || true; fi
  rm -rf "$work"
}
trap cleanup EXIT
cd "$work"

make_ca() {
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=Throwaway $1" \
    -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign" \
    -keyout "$1.key" -out "$1.crt" 2>/dev/null
  openssl req -newkey rsa:2048 -nodes -subj "/CN=localhost" \
    -keyout "$1-leaf.key" -out "$1-leaf.csr" 2>/dev/null
  printf 'subjectAltName=DNS:localhost\n' > san.ext
  openssl x509 -req -in "$1-leaf.csr" -CA "$1.crt" -CAkey "$1.key" -CAcreateserial -days 1 \
    -extfile san.ext -out "$1-leaf.crt" 2>/dev/null
}

make_ca os-ca
make_ca extra-ca
cp os-ca.crt /usr/local/share/ca-certificates/throwaway-os-ca.crt
update-ca-certificates >/dev/null 2>&1

cat > server.mjs <<'JS'
import https from "node:https";
import fs from "node:fs";

for (const [name, port] of [["os-ca", 8443], ["extra-ca", 8444]]) {
  const server = https.createServer(
    {
      key: fs.readFileSync(`${name}-leaf.key`),
      cert: fs.readFileSync(`${name}-leaf.crt`) + fs.readFileSync(`${name}.crt`),
    },
    (_request, response) => response.end("ok\n"),
  );
  await new Promise((resolve) => server.listen(port, resolve));
}
console.log("READY");
JS

node server.mjs > server.log 2>&1 &
server_pid=$!
for _ in $(seq 1 100); do
  if grep -q '^READY$' server.log; then break; fi
  if ! kill -0 "$server_pid" 2>/dev/null; then cat server.log >&2; exit 1; fi
  sleep 0.1
done
if ! grep -q '^READY$' server.log; then cat server.log >&2; exit 1; fi

cat > probe.mjs <<'JS'
import tls from "node:tls";
import { X509Certificate } from "node:crypto";

const stage = process.argv[2];
if (stage === "after") {
  const { trustSystemCertificates } = await import("/repro/systemCertificates.ts");
  const added = trustSystemCertificates();
  console.log(`trustSystemCertificates() -> ${added}`);
  if (!added) process.exitCode = 1;
}

const fingerprints = (type) =>
  new Set(tls.getCACertificates(type).map((certificate) => new X509Certificate(certificate).fingerprint256));
const defaults = fingerprints("default");
const kept = (type) => [...fingerprints(type)].every((fingerprint) => defaults.has(fingerprint));
const bundledKept = kept("bundled");
const extraKept = kept("extra");
console.log(`all bundled roots kept: ${bundledKept}`);
console.log(`NODE_EXTRA_CA_CERTS kept: ${extraKept}`);
if (!bundledKept || !extraKept) process.exitCode = 1;

const fetchResult = async (label, url) => {
  try {
    const response = await fetch(url);
    console.log(`fetch ${label} HTTP ${response.status}`);
    return response.status === 200;
  } catch (error) {
    const code = error.cause?.code ?? error.code ?? error.message;
    console.log(`fetch ${label} ${code}`);
    return false;
  }
};

const systemTrusted = await fetchResult("OS-trusted CA", "https://localhost:8443/");
const extraTrusted = await fetchResult("NODE_EXTRA_CA_CERTS", "https://localhost:8444/");
if (stage === "before" ? systemTrusted : !systemTrusted) process.exitCode = 1;
if (!extraTrusted) process.exitCode = 1;
JS

curl --fail --silent --show-error https://localhost:8443/
export NODE_EXTRA_CA_CERTS="$PWD/extra-ca.crt"
echo "--- node fetch with defaults"
node probe.mjs before
echo "--- node fetch after adding the OS store"
node probe.mjs after
INSIDE

docker run --rm --volume "$work:/repro:ro" node:24.22.0-bookworm bash /repro/inside.sh
