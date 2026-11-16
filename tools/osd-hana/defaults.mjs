// The one place that knows the public default passwords of HANA trial images.
//
// This is a courtesy check, nothing more (task B.3): if the person's password
// is one of a handful of defaults the trial images ship with, the doctor says
// so loudly and changes nothing -- the verdict, the exit code and every
// behaviour are the same. It is not a password audit: the list is tiny, the
// values are published in SAP's own installation guides, and the source
// holds them ONLY as the hex SHA-256 digests below, so this file does not
// become a dictionary. A real password policy question belongs to the
// database, not to us.
import {createHash} from "node:crypto";

// The hex SHA-256 digests of the published defaults: the SAP HANA Express
// installation-guide password, and the HANA system-user default of older
// trial images. (The plaintexts are public -- they are printed in SAP's own
// guides -- but they do not need to live in this repository.)
const DEFAULTS = [
  "25c714351de366e71c2483cf82309cf072f676ab91b9071766bd2321fab0cd0f",
  "6ee4a469cd4e91053847f5d3fcb61dbcc91e8f0ef10be7748da4c4a1ba382d17",
];

export function isPublicDefaultPassword(password) {
  if (typeof password !== "string" || password === "") return false;
  return DEFAULTS.includes(createHash("sha256").update(password).digest("hex"));
}

export function publicDefaultWarning() {
  return `osd hana: WARNING -- the password of this login is a public default of a HANA trial image.\n` +
    `  Anyone who can reach this port can log on with it. Change the password in the database\n` +
    `  (ALTER USER ...), especially before extracting anything. The doctor changed nothing.`;
}
