// The sidecar's TLS flags, in ONE place for every verb that runs the sidecar
// (doctor, extract). The rules (sidecar v2.62.1, capability "tls"):
//
//   --encrypt                   TLS with certificate validation
//   --trust-server-certificate  TLS WITHOUT validation (said loudly)
//   --ca-file F, --tls-server-name N
//                               shape the validation, so they need --encrypt
//                               (the sidecar itself refuses --ca-file with
//                               --trust-server-certificate)
//
// and the capability rule: a TLS ask against a sidecar without the "tls"
// capability is REFUSED, never a silent fall-back to clear text.

export const TLS_VALUE_FLAGS = Object.freeze(["ca-file", "tls-server-name"]);
export const TLS_BOOLEAN_FLAGS = Object.freeze(["encrypt", "trust-server-certificate"]);

/** Did the user ask for TLS at all? */
export function wantsTls(flags) {
  return flags.encrypt === true || flags["trust-server-certificate"] === true
    || flags["ca-file"] !== undefined || flags["tls-server-name"] !== undefined;
}

/** `--ca-file` / `--tls-server-name` without `--encrypt`: a usage error. */
export function tlsShapeWithoutEncrypt(flags) {
  return (flags["ca-file"] !== undefined || flags["tls-server-name"] !== undefined) && flags.encrypt !== true;
}

/** Does the hand-shaken sidecar list the "tls" capability? */
export function hasTlsCapability(handshakeInfo) {
  return Array.isArray(handshakeInfo?.capabilities) && handshakeInfo.capabilities.includes("tls");
}

/** The sidecar argv for the TLS flags: `{refused: true}` when TLS was asked
 *  for and the sidecar cannot do it, else `{args}` (empty without the
 *  capability or without an ask). */
export function sidecarTlsArgs(flags, handshakeInfo) {
  const capable = hasTlsCapability(handshakeInfo);
  if (wantsTls(flags) && !capable) return {refused: true, args: []};
  const args = [];
  if (capable) {
    if (flags.encrypt === true) args.push("--encrypt");
    if (flags["trust-server-certificate"] === true) args.push("--trust-server-certificate");
    if (flags["ca-file"] !== undefined) args.push("--ca-file", flags["ca-file"]);
    if (flags["tls-server-name"] !== undefined) args.push("--tls-server-name", flags["tls-server-name"]);
  }
  return {refused: false, args};
}
