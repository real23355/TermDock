import { writeFile } from 'node:fs/promises';

// Draw the existing >_ brand mark into transparent, multi-size ICO images.
const sizes = [16, 24, 32, 48, 64, 256];
const rect = (x, y, a, b, c, d) => x >= a && y >= b && x <= c && y <= d;
function bitmap(size) {
  const maskStride = Math.ceil(size / 32) * 4;
  const data = Buffer.alloc(40 + size * size * 4 + size * maskStride);
  data.writeUInt32LE(40, 0);
  data.writeUInt32LE(size, 4);
  data.writeUInt32LE(2 * size, 8);
  data.writeUInt16LE(1, 12);
  data.writeUInt16LE(32, 14);
  data.writeUInt32LE(size * size * 4, 20);
  for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) {
    let fill = 0, glyph = 0;
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
      const x = (col + (i + .5) / 4) * 32 / size;
      const y = (size - row - 1 + (j + .5) / 4) * 32 / size;
      const corner = Math.hypot(Math.max(0, Math.abs(x - 16) - 10), Math.max(0, Math.abs(y - 16) - 10));
      if (corner > 5.5) continue;
      fill++;
      if (rect(x, y, 7, 8.5, 17, 23.5) && Math.abs(x - (16 - Math.abs(y - 16) * 1.15)) < 1.6 ||
          rect(x, y, 17, 20.5, 25, 23.1)) glyph++;
    }
    const pixel = 40 + (row * size + col) * 4;
    if (fill) {
      const color = [0xff, 0xb0, 0x75].map((accent, channel) =>
        Math.round((accent * (fill - glyph) + [0x27, 0x19, 0x0f][channel] * glyph) / fill));
      data.set([color[2], color[1], color[0], Math.round(fill * 255 / 16)], pixel);
    } else {
      const byte = 40 + size * size * 4 + row * maskStride + Math.floor(col / 8);
      data[byte] |= 0x80 >> (col % 8);
    }
  }
  return data;
}

export async function buildWindowsIcon(destination) {
  const images = sizes.map(bitmap);
  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  for (const [index, image] of images.entries()) {
    const entry = 6 + index * 16;
    header[entry] = header[entry + 1] = sizes[index] % 256;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(image.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += image.length;
  }
  await writeFile(destination, Buffer.concat([header, ...images]));
}
