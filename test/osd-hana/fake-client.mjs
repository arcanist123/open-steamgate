// The FAKE hdb client the osd-hana tests inject through the reader's
// clientFactory seam, scripted with E1's answers (258 on create, 258 on grant,
// 332, success). Rules are matched against the SQL; the log records every
// connection and every statement with its bound parameters -- that log is
// what the assertions read. Fakes only -- no database.
export function fakeClientFactory(rules = []) {
  const log = {connections: [], statements: []};
  const factory = async (options) => {
    log.connections.push(options);
    return {
      exec: async (sql, params = []) => {
        log.statements.push({sql, params});
        for (const rule of rules) {
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
// the pre-create existence check and the absence proof.
export const SUCCESS_RULES = [
  {match: /CREATE USER/, rows: []},
  {match: /ALTER USER/, rows: []},
  {match: /GRANT SELECT/, rows: []},
  {match: /FROM SYS\.M_DATABASE/, rows: [{SYSTEM_ID: "SYSID-FIXTURE-1", DATABASE_NAME: "TEN", HOST: "hana-host-1"}]},
  {match: /FROM SYS\.SCHEMAS/, rows: [{OWNER_NAME: "SCHEMA_OWNER_LOGIN"}]},
  {match: /FROM SYS\.USERS/, rows: [{N: 0}]},
  {match: /"TADIR"/, rows: [{N: 42}]},
  {match: /DROP USER/, rows: []},
];
