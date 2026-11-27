// The one way a database client turns a failed SELECT into the exception an
// ABAP caller catches: CX_SY_DYNAMIC_OSQL_SEMANTICS with the engine's text in
// SQLMSG. Every client of the seam (SQLite file, DuckDB, DuckDB-wasm, HANA)
// calls this rather than building the exception itself.
//
// The exception is a JS Error too (cx_root extends Error), and a host that
// reports a failure reads `.message` -- tools/osd-serve.mjs and the ADT
// façade send String(e.message). A transpiled exception's own `.message` is
// empty, because the text lives in the ABAP attribute, so the client saw a
// 500 with nothing in it. The text is set on both, here, once.
//
// Without a running ABAP runtime (a tool using a client directly) the
// engine's own error is thrown unchanged.
export async function osqlSemanticsError(error) {
  const text = String(error?.message ?? error ?? "");
  const cx = globalThis.abap?.Classes?.["CX_SY_DYNAMIC_OSQL_SEMANTICS"];
  if (cx === undefined) {
    return error;
  }
  const exception = await new cx().constructor_({sqlmsg: text});
  exception.message = text;
  // the engine error's identity travels: a caller (and a test's assertion)
  // reads .code off what query() threw -- the 259 the bed measured is 259
  // again after the conversion, not undefined (FIX-4: the hana suite's
  // strict 259 under the suite runner, whose shared process has a runtime
  // booted by an earlier suite, so this conversion ran).
  if (error?.code !== undefined) exception.code = error.code;
  return exception;
}
