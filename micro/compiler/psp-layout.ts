// PSP's PRX loader copies one LOAD segment. prxgen does not repack separate
// ELF segments, so an alignment gap between them corrupts relocated tables.
export function validatePspLayout(bytes: Uint8Array): void {
  const b = Buffer.from(bytes);
  const check = (ok: boolean, reason: string) => {
    if (!ok) throw Error(`Invalid PSP PRX layout: ${reason}`);
  };
  check(b.length >= 52 && b.subarray(0, 6).equals(Buffer.from([127, 69, 76, 70, 1, 1])), "expected little-endian ELF32");
  check(b.readUInt16LE(16) === 0xffa0 && b.readUInt16LE(18) === 8, "expected MIPS PRX");
  const ph = b.readUInt32LE(28), sh = b.readUInt32LE(32);
  const phSize = b.readUInt16LE(42), phCount = b.readUInt16LE(44);
  const shSize = b.readUInt16LE(46), shCount = b.readUInt16LE(48);
  check(phSize >= 32 && phCount === 1 && ph + phSize <= b.length, "expected one program header");
  check(shSize >= 40 && sh + shCount * shSize <= b.length, "invalid section headers");
  check(b.readUInt32LE(ph) === 1, "expected LOAD segment");
  const file = b.readUInt32LE(ph + 4), address = b.readUInt32LE(ph + 8);
  const fileSize = b.readUInt32LE(ph + 16), memorySize = b.readUInt32LE(ph + 20);
  check(address === 0 && fileSize <= memorySize && file + fileSize <= b.length, "invalid LOAD bounds");
  for (let i = 0; i < shCount; i++) {
    const at = sh + i * shSize;
    if (!(b.readUInt32LE(at + 8) & 2)) continue; // SHF_ALLOC
    const start = b.readUInt32LE(at + 12), offset = b.readUInt32LE(at + 16), size = b.readUInt32LE(at + 20);
    check(start + size <= memorySize, `section ${i} exceeds LOAD memory`);
    if (b.readUInt32LE(at + 4) === 8 || size === 0) continue; // NOBITS
    check(offset === file + start && start + size <= fileSize,
      `section ${i} loads at the wrong address (file offset ${offset}, expected ${file + start})`);
  }
}
