// The FAKE hdb client the osd-hana tests inject through the reader's
// clientFactory seam, scripted with E1's answers (258 on create, 258 on grant,
// 332, success). Rules are matched against the SQL -- and, when a rule names
// a `user`, against the login the connection was opened AS (the two-login
// flow must send each statement with the right login). The log records every
// connection and every statement with its bound parameters -- that log is
// what the assertions read. Fakes only -- no database.
export function fakeClientFactory(rules = []) {
  const log = {connections: [], statements: []};
  const factory = async (options) => {
    log.connections.push(options);
    const mine = rules.filter((rule) => rule.user === undefined || rule.user === options.user);
    return {
      exec: async (sql, params = []) => {
        log.statements.push({sql, params, user: options.user});
        for (const rule of mine) {
          if (typeof rule.match === "string" ? sql.includes(rule.match) : rule.match.test(sql)) {
            if (rule.error !== undefined) {
              throw Object.assign(new Error(rule.message ?? `db error ${rule.error}`), {code: rule.error});
            }
            return {rows: rule.rows ?? []};
          }
        }
        return {rows: []};
      },
      disconnect: async () => {},
    };
  };
  return {log, factory};
}

// Rules for the success path, E1's SQL shapes. SYS.M_DATABASE carries the
// installation identity (S-A); SYS.USERS answers "nobody by that name" for
// the pre-create existence check and the absence proof; the write probe's
// UPDATE is REFUSED with 258 (the measured fact -- a reader without the
// grant may not write; the rule stands BEFORE the bare "TADIR" rule, which
// the UPDATE statement would otherwise match first).
export const SUCCESS_RULES = [
  {match: /CREATE USER/, rows: []},
  {match: /ALTER USER/, rows: []},
  {match: /GRANT SELECT/, rows: []},
  {match: /GRANT CATALOG READ/, rows: []},
  {match: /SET "PGMID" = "PGMID"/, error: 258, message: "insufficient privilege: the reader may not write"},
  {match: /FROM SYS\.M_DATABASE/, rows: [{SYSTEM_ID: "SYSID-FIXTURE-1", DATABASE_NAME: "TEN", HOST: "hana-host-1"}]},
  {match: /FROM SYS\.SCHEMAS/, rows: [{OWNER_NAME: "SCHEMA_OWNER_LOGIN"}]},
  {match: /FROM SYS\.USERS/, rows: [{N: 0}]},
  {match: /"TADIR"/, rows: [{N: 42}]},
  {match: /DROP USER/, rows: []},
];
