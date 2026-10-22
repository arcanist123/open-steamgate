// Capture-free session builders shared by the wire suite and parity probe.
import {expect} from "chai";
import {encodeUtf16le, encodeRfcFieldChain, decodeRfcFieldChain} from "./rfc.mjs";

export function cutRequest(xml, functionName = "SADT_REST_RFC_ENDPOINT") {
  const fields = [
    {tag: 0x000b, value: Buffer.from([0, 6, 0x37, 0, 0x35, 0])},
    {tag: 0x0102, value: encodeUtf16le(functionName)},
    {tag: 0x0512},
    {tag: 0x0205, value: encodeUtf16le("RESPONSE")},
    {tag: 0x3c02},
    {tag: 0x3c05, value: Buffer.from(xml)},
    {tag: 0x3c02},
    {tag: 0xffff},
  ];
  const chain = encodeRfcFieldChain(0x0502, fields);
  const total = 4 + chain.length + 10;
  const trailer = Buffer.alloc(10);
  trailer.writeUInt16BE(0xffff, 0);
  trailer.writeUInt16BE(total - 8, 4);
  trailer.writeUInt16BE(0x8500, 8);
  return Buffer.concat([Buffer.from([5, 2, 0, 0]), chain, trailer]);
}

export function eclipseRequest(xml, functionName = "SADT_REST_RFC_ENDPOINT") {
  const fields = [
    {tag: 0x0101, value: Buffer.from([4, 2, 1, 5, 4, 1, 0, 2])},
    {tag: 0x0103, value: Buffer.from("00000e0b", "hex")},
    {tag: 0x0102, value: Buffer.from(functionName, "utf16le").swap16()},
    {tag: 0x0512},
    {tag: 0x0205, value: Buffer.from("RESPONSE", "utf16le").swap16()},
    {tag: 0x3c02},
    {tag: 0x3c05, value: Buffer.from(xml)},
    {tag: 0x3c02},
    {tag: 0xffff},
  ];
  const encoded = encodeRfcFieldChain(0, fields).subarray(2);
  const total = encoded.length + 10;
  const trailer = Buffer.alloc(10);
  trailer.writeUInt16BE(0xffff, 0);
  trailer.writeUInt16BE(total - 8, 4);
  trailer.writeUInt16BE(0x8500, 8);
  return Buffer.concat([encoded, trailer]);
}

export function eclipseCompactRequest(document) {
  const fields = [
    {tag: 0x0101, value: Buffer.from([4, 2, 1, 5, 4, 1, 0, 2])},
    {tag: 0x0102, value: Buffer.from("SADT_REST_RFC_ENDPOINT", "utf16le").swap16()},
    {tag: 0x0512}, {tag: 0x0205, value: Buffer.from("RESPONSE", "utf16le").swap16()},
    {tag: 0x4000, value: Buffer.from([1, 0])}, {tag: 0x4001, value: document}, {tag: 0x4004}, {tag: 0xffff},
  ];
  const encoded = encodeRfcFieldChain(0, fields).subarray(2);
  const trailer = Buffer.alloc(10);
  trailer.writeUInt16BE(0xffff, 0); trailer.writeUInt16BE(encoded.length + 2, 4); trailer.writeUInt16BE(0x8500, 8);
  return Buffer.concat([encoded, trailer]);
}

export function requestXml(path = "/sap/bc/adt/core/http/build", method = "GET") {
  return `<REQUEST><REQUEST_LINE><METHOD>${method}</METHOD><URI>${path}</URI><VERSION>HTTP/1.1</VERSION></REQUEST_LINE><HEADER_FIELDS><item><NAME>Accept</NAME><VALUE>*/*</VALUE></item><item><NAME>Authorization</NAME><VALUE>Bearer caller-token</VALUE></item></HEADER_FIELDS><MESSAGE_BODY></MESSAGE_BODY></REQUEST>`;
}

export function appc(fn, length = 80) {
  const frame = Buffer.alloc(length);
  frame[0] = 6;
  frame[1] = fn;
  frame.writeUInt16BE(8, 26);
  frame[30] = 5;
  frame[31] = 0x0c;
  frame.write("00000001", 40, "ascii");
  return frame;
}

export function dataRecord(cut) {
  const header = appc(0xcb);
  header.writeUInt16BE(7, 4);
  return Buffer.concat([header, cut]);
}

export function logonPacket(passwordField = "150000008981dc9b914e", flavor = "probe") {
  const fields = [
    ...(flavor === "jco" ? [{tag: 0x0100, value: Buffer.from([1])}] : []),
    {tag: 0x0101}, {tag: 0x0103, value: Buffer.from("00000e09", "hex")},
    {tag: 0x0106, value: Buffer.from("04010003000a0200000023", "hex")}, {tag: 0x0337},
    {tag: 0x0514, value: Buffer.alloc(16, 7)}, {tag: 0x0114, value: Buffer.from("001")},
    {tag: 0x0111, value: Buffer.from("DEVELOPER")}, {tag: 0x0117, value: Buffer.from(passwordField, "hex")},
    {tag: 0x0115, value: Buffer.from("E")}, {tag: 0x0501, value: Buffer.from([1])},
    {tag: 0x0007, value: Buffer.from("127.0.0.1")}, {tag: 0x0018, value: Buffer.from("::1")},
    {tag: 0x0011, value: Buffer.from("E")}, {tag: 0x0012, value: Buffer.from("754")},
    {tag: 0x0013, value: Buffer.from("754")}, {tag: 0x0008, value: Buffer.from("test-host")},
    {tag: 0x0006, value: Buffer.from("TEST")}, {tag: 0x0130, value: Buffer.from("TEST")},
    {tag: 0x0502}, {tag: 0x000b, value: Buffer.from("754")}, {tag: 0x0102, value: Buffer.from("RFCPING")}, {tag: 0xffff},
  ];
  const selector = flavor === "jco" ? "0102" : "0301";
  const prefix = Buffer.from(`d9c6c3f0f0f0f0f0f0f0f0f001010008${selector}`, "hex");
  const chain = encodeRfcFieldChain(0x0101, fields);
  const trailer = Buffer.alloc(10);
  trailer.writeUInt16BE(0xffff, 0);
  trailer.writeUInt16BE(prefix.length + chain.length + 2, 4);
  trailer.writeUInt32BE(0x8500, 6);
  return Buffer.concat([prefix, chain, trailer]);
}

export function responseXml(frame) {
  const cut = frame.subarray(80);
  expect(cut.subarray(0, 4).toString("hex")).to.equal("05000000");
  const chain = decodeRfcFieldChain(cut.subarray(4), 0x0500);
  return Buffer.concat(chain.fields.filter((field) => field.tag === 0x3c05).map((field) => field.value)).toString();
}

