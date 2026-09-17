import { expect, test } from "bun:test";
import { validatePspLayout } from "../compiler/psp-layout.ts";

function fixture(gap = 0): Buffer {
  const b = Buffer.alloc(1024);
  b.set([127, 69, 76, 70, 1, 1]);
  b.writeUInt16LE(0xffa0, 16); b.writeUInt16LE(8, 18);
  b.writeUInt32LE(52, 28); b.writeUInt32LE(768, 32);
  b.writeUInt16LE(32, 42); b.writeUInt16LE(1, 44);
  b.writeUInt16LE(40, 46); b.writeUInt16LE(3, 48);
  b.writeUInt32LE(1, 52); b.writeUInt32LE(128, 56);
  b.writeUInt32LE(256 + gap, 68); b.writeUInt32LE(512, 72);
  function section(i: number, type: number, address: number, offset: number, size: number) {
    const at = 768 + i * 40;
    b.writeUInt32LE(type, at + 4); b.writeUInt32LE(2, at + 8);
    b.writeUInt32LE(address, at + 12); b.writeUInt32LE(offset, at + 16); b.writeUInt32LE(size, at + 20);
  }
  section(0, 1, 0, 128, 128);
  section(1, 1, 128, 256 + gap, 128);
  section(2, 8, 256, 384 + gap, 256);
  return b;
}

test("PRX accepts contiguous loaded sections and zero-filled BSS", () => {
  expect(() => validatePspLayout(fixture())).not.toThrow();
});
test("PRX rejects the 32-byte alignment gap that corrupts hardware imports", () => {
  expect(() => validatePspLayout(fixture(32))).toThrow("loads at the wrong address");
});
test("PRX rejects a truncated image before reading headers", () => {
  expect(() => validatePspLayout(fixture().subarray(0, 64))).toThrow("program header");
});
