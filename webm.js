// MediaRecorder writes WebM without a Segment Info Duration, so players show
// a stream with no length. This inserts the missing Duration element into the
// header and leaves the rest of the file untouched.
//
// Only the first 128 KB is read, which always covers the EBML header, Segment
// header, SeekHead, Info and Tracks that come before the first Cluster.

const ID = {
  ebml: 0x1a45dfa3,
  segment: 0x18538067,
  seekHead: 0x114d9b74,
  info: 0x1549a966,
  cluster: 0x1f43b675,
  timecodeScale: 0x2ad7b1,
  duration: 0x4489,
};
const HEAD_BYTES = 128 * 1024;

function readId(b, p) {
  let len = 1;
  let mask = 0x80;
  while (len <= 4 && !(b[p] & mask)) {
    len++;
    mask >>= 1;
  }
  if (len > 4 || p + len > b.length) return null;
  let id = 0;
  for (let i = 0; i < len; i++) id = id * 256 + b[p + i];
  return { id, len };
}

// size is -1 for the "unknown size" marker (all value bits set).
function readSize(b, p) {
  let len = 1;
  let mask = 0x80;
  while (len <= 8 && !(b[p] & mask)) {
    len++;
    mask >>= 1;
  }
  if (len > 8 || p + len > b.length) return null;
  let value = b[p] & (mask - 1);
  let unknown = value === mask - 1;
  for (let i = 1; i < len; i++) {
    value = value * 256 + b[p + i];
    if (b[p + i] !== 0xff) unknown = false;
  }
  return { size: unknown ? -1 : value, len };
}

function writeSize8(value) {
  const out = new Uint8Array(8);
  out[0] = 0x01;
  let v = value;
  for (let i = 7; i >= 1; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  return out;
}

function readUint(b, start, end) {
  let v = 0;
  for (let i = start; i < end; i++) v = v * 256 + b[i];
  return v;
}

function durationElement(value) {
  const out = new Uint8Array(11);
  out[0] = 0x44;
  out[1] = 0x89;
  out[2] = 0x88; // size 8
  new DataView(out.buffer).setFloat64(3, value);
  return out;
}

/**
 * Returns a blob with a Duration element added, or the original blob when the
 * layout is not one this code understands (already has a duration, unexpected
 * structure, known segment size too small to grow).
 */
export async function addDuration(blob, durationSeconds) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return blob;

  const head = new Uint8Array(await blob.slice(0, HEAD_BYTES).arrayBuffer());

  const ebml = readId(head, 0);
  if (ebml?.id !== ID.ebml) return blob;
  const ebmlSize = readSize(head, ebml.len);
  if (!ebmlSize || ebmlSize.size < 0) return blob;
  let p = ebml.len + ebmlSize.len + ebmlSize.size;

  const segment = readId(head, p);
  if (segment?.id !== ID.segment) return blob;
  const segSizePos = p + segment.len;
  const segSize = readSize(head, segSizePos);
  if (!segSize) return blob;
  p = segSizePos + segSize.len;

  const voidedSeekHeads = [];
  while (p < head.length) {
    const el = readId(head, p);
    if (!el || el.id === ID.cluster) return blob;
    const size = readSize(head, p + el.len);
    if (!size || size.size < 0) return blob;
    const bodyStart = p + el.len + size.len;
    const end = bodyStart + size.size;
    if (end > head.length) return blob;

    if (el.id === ID.seekHead) voidedSeekHeads.push({ start: p, end });

    if (el.id === ID.info) {
      let timecodeScale = 1_000_000;
      for (let q = bodyStart; q < end; ) {
        const child = readId(head, q);
        const childSize = child && readSize(head, q + child.len);
        if (!childSize || childSize.size < 0) return blob;
        const childBody = q + child.len + childSize.len;
        if (child.id === ID.duration) return blob;
        if (child.id === ID.timecodeScale) timecodeScale = readUint(head, childBody, childBody + childSize.size);
        q = childBody + childSize.size;
      }

      const duration = durationElement((durationSeconds * 1e9) / timecodeScale);
      const newBodySize = size.size + duration.length;
      const infoIdBytes = head.slice(p, p + el.len);

      const prefix = head.slice(0, p);

      // A SeekHead stores byte offsets that this edit would shift, so turn it
      // into a Void element of the same length.
      for (const sh of voidedSeekHeads) {
        const total = sh.end - sh.start;
        if (total < 9) return blob;
        prefix[sh.start] = 0xec;
        prefix.set(writeSize8(total - 9), sh.start + 1);
      }

      // A known Segment size has to grow by the bytes we add.
      if (segSize.size >= 0) {
        const grown = segSize.size + (el.len + 8 + newBodySize - (end - p));
        if (grown >= 2 ** (7 * segSize.len)) return blob;
        let v = grown;
        for (let i = segSize.len - 1; i >= 0; i--) {
          prefix[segSizePos + i] = v % 256;
          v = Math.floor(v / 256);
        }
        prefix[segSizePos] |= 1 << (8 - segSize.len);
      }

      return new Blob(
        [prefix, infoIdBytes, writeSize8(newBodySize), head.slice(bodyStart, end), duration, blob.slice(end)],
        { type: blob.type },
      );
    }
    p = end;
  }
  return blob;
}
