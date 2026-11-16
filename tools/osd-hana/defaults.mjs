// The one place that knows the public default passwords of HANA trial images.
//
// This is a courtesy check, nothing more (task B.3): if the person's password
// is one of a handful of defaults the trial images ship with, the doctor says
// so loudly and changes nothing -- the verdict, the exit code and every
// behaviour are the same. It is not a password audit: the list is tiny, the
// values below are published in SAP's own installation guides, and they are
// kept as SHA-256 hashes so this file does not become a dictionary. A real
// password policy question belongs to the database, not to us.
import {createHash} from "node:crypto";

// Computed once at load; the entries are the hex SHA-256 of the published
// defaults ("HXEHana1" -- the SAP HANA Express installation guide; "manager" --
// the HANA system-user default of older trial images).
const DEFAULTS = ["HXEHana1", "manager"].map((value) => createHash("sha256").update(value).digest("hex"));

export function isPublicDefaultPassword(password) {
  if (typeof password !== "string" || password === "") return false;
  return DEFAULTS.includes(createHash("sha256").update(password).digest("hex"));
}

export function publicDefaultWarning() {
  return `osd hana: WARNING -- the password of this login is a public default of a HANA trial image.\n` +
    `  Anyone who can reach this port can log on with it. Change the password in the database\n` +
    `  (ALTER USER ...), especially before extracting anything. The doctor changed nothing.`;
}
