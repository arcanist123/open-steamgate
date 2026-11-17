// The ONE place the reader path touches the npm driver `hdb`.
//
// Reader code (reader.mjs, reader-run.mjs, reader-shared.mjs, doctor.mjs)
// speaks a small interface and nothing else:
//
//   const client = await connect(options);   // host, port, user, password,
//                                            // databaseName, useTLS, ca,
//                                            // servername, rejectUnauthorized
//   const {rows} = await client.exec(sql, params = []);
//   await client.disconnect();
//
// and every error it sees carries a NUMERIC `code`: the database's own error
// number (258, 332, ...) or CONNECTION_FAILED for a driver/network failure.
//
// Why this module exists: the reader once called `hdb.createConnection`, which
// hdb does not have (it exports `createClient`), and passed bind parameters as
// `client.exec`'s second argument, which hdb reads as OPTIONS -- a statement
// with `?` went out unbound. Every test injected a fake with the same invented
// API, so ~100 tests were green against nothing. The fakes now stand at this
// interface, and test/osd-hana-hdb-adapter.mjs holds the adapter to the real
// module: the API it calls must exist on the installed hdb ("the fake may not
// invent"), and a connect to a dead port must come back as CONNECTION_FAILED.
//
// The hdb API used, read off node_modules/hdb (2.x):
//   hdb.createClient(options) -> Client (an EventEmitter)
//   client.connect(cb(err))
//   client.exec(sql, cb(err, rowsOrAffectedCount))         -- no parameters
//   client.prepare(sql, cb(err, statement))                -- with parameters
//     statement.exec(values, cb(err, rowsOrAffectedCount)); statement.drop(cb)
//   client.disconnect(cb(err)); client.close()
//   errors: SqlError with numeric `code` (+ sqlState, level); driver failures
//     are Errors with a STRING code ('EHDBOPENCONN', 'EHDBTIMEOUT', ...).
//
// The import is static on purpose: the compiled `osd` binary (Bun) bundles
// what is imported statically, and a `createRequire("hdb")` at run time finds
// no node_modules beside the binary.
import hdb from "hdb";

/** The number a driver or network failure is reported under: SAP's client
 *  error "Connection failed" (SQLDBC -10709). Negative, so it can never be
 *  mistaken for a database error number. */
export const CONNECTION_FAILED = -10709;

/** An error with a numeric code, whatever the driver threw. Errors that
 *  already carry a number pass unchanged (the database refused); errors with
 *  a string code (driver/network) become CONNECTION_FAILED with the original
 *  code kept as `driverCode` and the original as `cause`; anything without a
 *  code is a bug of ours or of the driver and is thrown as it came. */
export function mapHdbError(error) {
  if (error === null || typeof error !== "object") return new Error(String(error));
  if (typeof error.code === "number") return error;
  if (typeof error.code === "string") {
    return Object.assign(new Error(error.message, {cause: error}), {code: CONNECTION_FAILED, driverCode: error.code});
  }
  return error;
}

/** Whatever hdb's callback handed back -> `{rows}`. A SELECT gives an array
 *  of row objects; DDL/DML gives an affected-row count, which is no rows. */
export function toResult(value) {
  return {rows: Array.isArray(value) ? value : []};
}

const call = (fn) => new Promise((resolvePromise, reject) => {
  fn((error, value) => (error ? reject(mapHdbError(error)) : resolvePromise(value)));
});

/** The real client factory: `connect(options)` -> the reader's interface.
 *  `driver` is the seam the adapter's own tests use; reader code never
 *  passes it. */
export function hdbClientFactory({driver = hdb} = {}) {
  return async function connect(options) {
    const client = driver.createClient({...options});
    // hdb emits 'error' only when somebody listens; an asynchronous socket
    // error after connect must not become an unhandled exception either way.
    client.on?.("error", () => {});
    try {
      await call((cb) => client.connect(cb));
    } catch (error) {
      try { client.close(); } catch { /* already gone */ }
      throw error;
    }
    return {
      options,
      async exec(sql, params = []) {
        if (params.length === 0) {
          return toResult(await call((cb) => client.exec(sql, cb)));
        }
        const statement = await call((cb) => client.prepare(sql, cb));
        try {
          return toResult(await call((cb) => statement.exec(params, cb)));
        } finally {
          await new Promise((resolvePromise) => statement.drop(() => resolvePromise()));
        }
      },
      async disconnect() {
        await new Promise((resolvePromise) => client.disconnect(() => resolvePromise()));
        try { client.close(); } catch { /* already closed */ }
      },
    };
  };
}
