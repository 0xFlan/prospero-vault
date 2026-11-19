/** Minimal but real param.sfo writer: 20-byte header, entry table, key table, data table. */
export function buildSfo(entries: Record<string, string>): Uint8Array {
  const keys = Object.keys(entries).sort();
  const encoder = new TextEncoder();
  const keyBlobs = keys.map((key) => encoder.encode(`${key}\0`));
  const valueBlobs = keys.map((key) => encoder.encode(`${entries[key]}\0`));
  const pad4 = (n: number) => (n + 3) & ~3;
  const padded = valueBlobs.map((blob) => pad4(blob.length));

  const headerSize = 20;
  const entrySize = 16;
  const keyTableStart = headerSize + entrySize * keys.length;
  const keyTableSize = keyBlobs.reduce((sum, blob) => sum + blob.length, 0);
  const dataTableStart = keyTableStart + keyTableSize;
  const dataTableSize = padded.reduce((sum, size) => sum + size, 0);

  const out = new Uint8Array(dataTableStart + dataTableSize);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46535000, true); // "\0PSF"
  view.setUint32(4, 0x00000101, true);
  view.setUint32(8, keyTableStart, true);
  view.setUint32(12, dataTableStart, true);
  view.setUint32(16, keys.length, true);

  let keyOffset = 0;
  let dataOffset = 0;
  keys.forEach((_, index) => {
    const entry = headerSize + index * 16;
    view.setUint16(entry, keyOffset, true);
    view.setUint16(entry + 2, 0x0204, true); // UTF-8, NUL terminated
    view.setUint32(entry + 4, valueBlobs[index].length, true);
    view.setUint32(entry + 8, padded[index], true);
    view.setUint32(entry + 12, dataOffset, true);
    out.set(keyBlobs[index], keyTableStart + keyOffset);
    out.set(valueBlobs[index], dataTableStart + dataOffset);
    keyOffset += keyBlobs[index].length;
    dataOffset += padded[index];
  });
  return out;
}

export function readSfo(bytes: Uint8Array): Record<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46535000) throw new Error("not an SFO");
  const keyTable = view.getUint32(8, true);
  const dataTable = view.getUint32(12, true);
  const count = view.getUint32(16, true);
  const decoder = new TextDecoder();
  const out: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    const entry = 20 + i * 16;
    const keyOffset = view.getUint16(entry, true);
    const format = view.getUint16(entry + 2, true);
    const length = view.getUint32(entry + 4, true);
    const dataOffset = view.getUint32(entry + 12, true);
    if (format === 0x0404) continue;
    let end = keyTable + keyOffset;
    while (end < bytes.length && bytes[end] !== 0) end++;
    const key = decoder.decode(bytes.subarray(keyTable + keyOffset, end));
    const start = dataTable + dataOffset;
    out[key] = decoder.decode(bytes.subarray(start, Math.min(start + length, bytes.length))).replace(/\0+$/, "");
  }
  return out;
}
