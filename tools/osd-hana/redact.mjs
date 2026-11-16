// The redactor every byte the sidecar child writes to stderr goes through
// (tools/osd-hana/sidecar.mjs). The child knows the credentials of this run
// only through its environment, but it may still echo one of them in a
// progress line or an error text -- and this module's own messages must not
// leak them either. Four values are masked: the password, the user, the host
// and the schema of this run. Everything else passes untouched.
//
// The masking is literal substring replacement, longest value first, plus the
// JSON-string-encoded form of each value (a progress line may quote them), and
// a form wrapped in single quotes, which is how a driver error repeats a
// value back. A redactor that must also survive URL-encoding belongs to the
// sidecar's own side of the seam, not here.
//
// Secrets shorter than 3 characters are ignored on purpose: with user "U"
// every capital U in the child's output would otherwise become "***" (critic
// note) -- a one-character value is not a findable secret, it is alphabet
// poison.

const SENTINEL = "***";
const MIN_SECRET_LENGTH = 3;

export function makeRedactor(values) {
  const secrets = [...new Set(values.filter((v) => typeof v === "string" && v.length >= MIN_SECRET_LENGTH))]
    .sort((a, b) => b.length - a.length);
  const forms = [];
  for (const secret of secrets) {
    forms.push(secret);
    try {
      forms.push(JSON.stringify(secret).slice(1, -1));
    } catch { /* not reachable for a string */ }
    forms.push(`'${secret}'`);
  }
  return function redact(text) {
    if (typeof text !== "string") return text;
    let out = text;
    for (const form of forms) {
      if (out.includes(form)) out = out.split(form).join(SENTINEL);
    }
    return out;
  };
}

// Wraps a writable (process.stderr or a captured sink): every write goes
// through the redactor first, then to the underlying stream unchanged in
// shape (strings pass through; Buffers are decoded and re-encoded).
export function redactingSink(write, redact) {
  return function redactedWrite(chunk, encoding, cb) {
    if (typeof chunk === "string") {
      return write.call(this, redact(chunk), encoding, cb);
    }
    if (Buffer.isBuffer(chunk)) {
      return write.call(this, Buffer.from(redact(chunk.toString("utf8")), "utf8"), encoding, cb);
    }
    return write.call(this, chunk, encoding, cb);
  };
}
