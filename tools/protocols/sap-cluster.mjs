// An ABAP data cluster, the one shape a MIME object is stored in: what
// EXPORT ... TO DATABASE writes into an INDX-like table (WWWDATA, RELID MI
// for an SMW0 object) and only IMPORT was meant to read back.
//
// Ported, narrowed, from the MIT vibing-steampunk reader (pkg/datacluster,
// `vsp cluster decode`), which is the reference for every byte read here
// and reads far more (structures with strings and nested tables, the
// pre-Unicode format 5, DDIC layouts). This file reads the flat shapes
// only -- an elementary field, a flat structure, a flat table of fixed-
// length fields -- and hands each row back as its raw bytes, because a
// MIME object is a table of RAW 255 lines and nothing more is needed to
// serve one. Anything else is refused by name, never guessed at.
//
// The stream (format version 6):
//   16-byte header: FF, version, ..., [4] 01 plain / 02 compressed,
//     [8..12) the code page (ASCII digits);
//   a body, SAP-LZH/LZC compressed when [4] is 02 (./sap-compress.mjs);
//   per object: a 32-byte header (kind, type code, decimals, row length
//     big-endian at 3, size at 7, name length at 11), the name in UTF-16LE,
//     a descriptor of 7-byte entries (marker, type, decimals, length) for a
//     structure (AB..AC) or a table line (AD..AE) with leaves AA and
//     alignment fillers AF, then the data: a table as BE, line length,
//     row count, the rows, BF; a row as BC, length, bytes, BD;
//   04 ends the stream.
import {decompressSAP} from "./sap-compress.mjs";

export class SAPClusterError extends Error {
  constructor(message) {
    super(`sap-cluster: ${message}`);
    this.name = "SAPClusterError";
  }
}

const HEADER = 16;
const MARK = {struct: 0xab, structEnd: 0xac, table: 0xad, tableEnd: 0xae, leaf: 0xaa, filler: 0xaf,
  row: 0xbc, rowEnd: 0xbd, data: 0xbe, dataEnd: 0xbf, string: 0xca, end: 0x04};
const KIND = {1: "elementary", 2: "structure", 3: "table"};

/** the fragments of one cluster key joined back into one stream: sorted by
 *  SRTF2, each trimmed to the CLUSTR its row declares (the database pads
 *  every row to the column). A gap or a repeat is refused. `rows` are
 *  {srtf2, clustr, clustd}, clustd a Buffer or hex text. */
export function joinFragments(rows) {
  if (rows.length === 0) throw new SAPClusterError("no fragments");
  const sorted = [...rows].map((r) => ({seq: Number(r.srtf2), length: Number(r.clustr), data: asBytes(r.clustd)}))
    .sort((a, b) => a.seq - b.seq);
  sorted.forEach((f, i) => {
    if (f.seq !== i) throw new SAPClusterError(`fragment ${i} is ${sorted.some((g) => g.seq === i) ? "repeated" : "missing"}`);
  });
  return Buffer.concat(sorted.map((f) => f.data.subarray(0, f.length > 0 && f.length <= f.data.length ? f.length : f.data.length)));
}

function asBytes(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value);
  const text = String(value ?? "").replace(/^0x/i, "").replace(/\s+/g, "");
  if (/^[0-9a-f]*$/i.test(text) === false || text.length % 2 !== 0) throw new SAPClusterError("CLUSTD is neither bytes nor hex");
  return Buffer.from(text, "hex");
}

/** one parsed cluster: {version, codepage, compressed, objects: [{name,
 *  kind, rowLength, fields: [length...], rows: [Buffer]}]} */
export function parseCluster(blob) {
  const bytes = asBytes(blob);
  if (bytes.length < HEADER) throw new SAPClusterError(`${bytes.length} bytes is shorter than the ${HEADER}-byte header`);
  if (bytes[0] !== 0xff) throw new SAPClusterError(`no cluster marker (first byte ${bytes[0]})`);
  const version = bytes[1];
  if (version !== 6) throw new SAPClusterError(`format version ${version} is not read here (6 is; vsp cluster decode reads 5)`);
  const codepage = bytes.subarray(8, 12).toString("latin1");
  let body = bytes.subarray(HEADER);
  const compressed = bytes[4] === 2;
  if (compressed) body = decompressSAP(body, {maxOutputLength: 256 * 1024 * 1024});
  else if (bytes[4] !== 1) throw new SAPClusterError(`unknown body format ${bytes[4]}`);
  const objects = [];
  let pos = 0;
  const need = (n) => {
    if (n < 0 || pos + n > body.length) throw new SAPClusterError(`truncated at offset ${pos}: need ${n} more byte(s)`);
  };
  const u32 = () => { need(4); const v = body.readUInt32BE(pos); pos += 4; return v; };
  while (true) {
    need(1);
    if (body[pos] === MARK.end) break;
    need(32);
    const kind = KIND[body[pos]];
    if (kind === undefined) throw new SAPClusterError(`object kind ${body[pos]} at offset ${pos} is not a flat one (vsp cluster decode reads deep objects)`);
    const typeCode = body[pos + 1];
    const rowLength = body.readUInt32BE(pos + 3);
    const nameLength = body[pos + 11];
    pos += 32;
    need(nameLength * 2);
    const name = body.subarray(pos, pos + nameLength * 2).toString("utf16le");
    pos += nameLength * 2;
    let fields = [rowLength];
    if (kind !== "elementary") {
      fields = [];
      need(7);
      const open = kind === "table" ? MARK.table : MARK.struct;
      const close = kind === "table" ? MARK.tableEnd : MARK.structEnd;
      if (body[pos] !== open) throw new SAPClusterError(`object ${name}: descriptor marker ${body[pos]} at offset ${pos}, not ${open}`);
      pos += 7;
      for (;;) {
        need(7);
        const marker = body[pos];
        const length = body.readUInt32BE(pos + 3);
        pos += 7;
        if (marker === close) break;
        if (marker === MARK.leaf) fields.push(length);
        else if (marker === MARK.filler) fields.push(-length);
        else throw new SAPClusterError(`object ${name}: descriptor entry ${marker} is not flat (vsp cluster decode reads nested ones)`);
      }
      const sum = fields.reduce((s, l) => s + Math.abs(l), 0);
      if (sum !== rowLength) throw new SAPClusterError(`object ${name}: fields sum to ${sum}, the row is ${rowLength}`);
    }
    const row = () => {
      // one row: BC runs until the row's bytes are all there
      const parts = [];
      let have = 0;
      while (have < rowLength) {
        need(1);
        if (body[pos] === MARK.string) throw new SAPClusterError(`object ${name}: a string value in a row is not flat`);
        if (body[pos] !== MARK.row) throw new SAPClusterError(`object ${name}: row marker ${body[pos]} at offset ${pos}`);
        pos += 1;
        const n = u32();
        need(n + 1);
        if (have + n > rowLength) throw new SAPClusterError(`object ${name}: a run of ${n} byte(s) overruns the ${rowLength}-byte row`);
        parts.push(body.subarray(pos, pos + n));
        pos += n;
        if (body[pos] !== MARK.rowEnd) throw new SAPClusterError(`object ${name}: run not closed at offset ${pos}`);
        pos += 1;
        have += n;
      }
      return Buffer.concat(parts);
    };
    const rows = [];
    if (kind === "table") {
      need(1);
      if (body[pos] !== MARK.data) throw new SAPClusterError(`object ${name}: table data marker ${body[pos]} at offset ${pos}`);
      pos += 1;
      const lineLength = u32();
      const count = u32();
      if (lineLength !== rowLength) throw new SAPClusterError(`object ${name}: data line length ${lineLength}, descriptor ${rowLength}`);
      if (count > body.length - pos) throw new SAPClusterError(`object ${name}: ${count} rows claimed, ${body.length - pos} bytes left`);
      for (let i = 0; i < count; i++) rows.push(row());
      need(1);
      if (body[pos] !== MARK.dataEnd) throw new SAPClusterError(`object ${name}: table not closed at offset ${pos}`);
      pos += 1;
    } else {
      rows.push(row());
    }
    objects.push({name, kind, typeCode, rowLength, fields: fields.filter((l) => l > 0), rows});
  }
  return {version, codepage, compressed, objects};
}

/** the bytes of an SMW0 MIME object: the cluster's one table, its lines
 *  concatenated, cut to `size` when the caller knows it (WWWPARAMS
 *  'filesize'; the last line is padded to 255 on the database). */
export function mimeBytes(cluster, size) {
  const table = cluster.objects.find((o) => o.kind === "table");
  if (table === undefined) throw new SAPClusterError("no table in the cluster: not a MIME object");
  const all = Buffer.concat(table.rows);
  if (size === undefined || Number.isFinite(size) === false) return all;
  if (size > all.length) throw new SAPClusterError(`filesize ${size} is more than the ${all.length} byte(s) the cluster holds`);
  return all.subarray(0, size);
}

// -------------------------------------------------------------------------
// The writer, for tests: a flat MIME table as a format-6 cluster, plain or
// SAP-LZH. Our own bytes, never a system's -- a fixture built here proves
// the reader against the format, and the bed proves it against a tenant.

/** SAP-LZH of `plain`: SAP's header, then raw DEFLATE shifted by two bits
 *  (the low two bits of the first byte say the shift is 2) */
export async function compressLZH(plain) {
  const {deflateRawSync} = await import("node:zlib");
  const deflated = deflateRawSync(plain);
  const body = Buffer.alloc(deflated.length + 1);
  for (let i = 0; i < deflated.length; i++) {
    body[i] |= (deflated[i] << 2) & 0xff;
    body[i + 1] |= deflated[i] >>> 6;
  }
  const header = Buffer.from([0, 0, 0, 0, 0x12, 0x1f, 0x9d, 0x02]);
  header.writeUInt32LE(plain.length, 0);
  return Buffer.concat([header, body]);
}

/** a MIME object as WWWDATA_EXPORT stores it: one table MIME of RAW 255 */
export async function mimeCluster(content, {compress = true, line = 255} = {}) {
  const chunks = [];
  for (let at = 0; at < content.length; at += line) {
    const one = Buffer.alloc(line);
    content.copy(one, 0, at, Math.min(content.length, at + line));
    chunks.push(one);
  }
  const name = Buffer.from("MIME", "utf16le");
  const head = Buffer.alloc(32);
  head[0] = 3;
  head[1] = 0x0e;
  head.writeUInt32BE(line, 3);
  head[11] = 4;
  const entry = (marker, type, length) => {
    const e = Buffer.alloc(7);
    e[0] = marker;
    e[1] = type;
    e.writeUInt32BE(length, 3);
    return e;
  };
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v); return b; };
  const stream = Buffer.concat([head, name, entry(MARK.table, 0x0e, line), entry(MARK.leaf, 0x04, line), entry(MARK.tableEnd, 0x0e, line),
    Buffer.from([MARK.data]), u32(line), u32(chunks.length),
    ...chunks.flatMap((c) => [Buffer.from([MARK.row]), u32(line), c, Buffer.from([MARK.rowEnd])]),
    Buffer.from([MARK.dataEnd, MARK.end])]);
  const header = Buffer.alloc(HEADER);
  header[0] = 0xff;
  header[1] = 6;
  header[4] = compress ? 2 : 1;
  header.write("4103", 8, "latin1");
  return Buffer.concat([header, compress ? await compressLZH(stream) : stream]);
}

/** a stream cut into WWWDATA rows: {srtf2, clustr, clustd (hex)} */
export function fragments(blob, width = 2886) {
  const rows = [];
  for (let at = 0, n = 0; at < blob.length; at += width, n++) {
    const part = blob.subarray(at, at + width);
    rows.push({srtf2: n, clustr: part.length, clustd: Buffer.concat([part, Buffer.alloc(width - part.length)]).toString("hex").toUpperCase()});
  }
  return rows;
}
