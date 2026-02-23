// Native Messaging framing: 4-byte little-endian length prefix, followed by UTF-8 JSON.

export function encodeNativeMessage(obj) {
  const json = Buffer.from(JSON.stringify(obj), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  return Buffer.concat([header, json]);
}

export function createNativeMessageReader(onMessage) {
  /** @type {Buffer} */
  let buf = Buffer.alloc(0);

  return function onChunk(chunk) {
    buf = Buffer.concat([buf, chunk]);

    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) return;

      const payload = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);

      try {
        const msg = JSON.parse(payload.toString("utf8"));
        onMessage(msg);
      } catch (e) {
        // ignore malformed message
      }
    }
  };
}
