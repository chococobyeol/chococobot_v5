import { readFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const RGBA_BYTES_PER_PIXEL = 4;

type RgbaImage = {
  width: number;
  height: number;
  pixels: Buffer;
};

type HorizontalCompositeOptions = {
  cardWidth?: number;
  gap?: number;
  padding?: number;
  background?: [number, number, number, number];
};

export function buildHorizontalPngComposite(imagePaths: readonly string[], options: HorizontalCompositeOptions = {}): Buffer {
  if (!imagePaths.length) throw new Error('imagePaths must contain at least one PNG');
  const cardWidth = options.cardWidth ?? 256;
  const gap = options.gap ?? 12;
  const padding = options.padding ?? 20;
  const background = options.background ?? [255, 255, 255, 255];
  const sourceImages = imagePaths.map((path) => decodePngRgba(readFileSync(path)));
  const cardHeight = Math.round(cardWidth * 1.5);
  const width = padding * 2 + sourceImages.length * cardWidth + Math.max(0, sourceImages.length - 1) * gap;
  const height = padding * 2 + cardHeight;
  const pixels = Buffer.alloc(width * height * RGBA_BYTES_PER_PIXEL);
  fillImage(pixels, background);

  sourceImages.forEach((image, index) => {
    const x = padding + index * (cardWidth + gap);
    drawScaledImage(pixels, width, image, x, padding, cardWidth, cardHeight);
  });

  return encodePngRgba({ width, height, pixels });
}

function decodePngRgba(buffer: Buffer): RgbaImage {
  if (!buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) throw new Error('Invalid PNG signature');
  let offset = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks: Buffer[] = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    offset += 4;
    const type = buffer.toString('ascii', offset, offset + 4);
    offset += 4;
    const data = buffer.subarray(offset, offset + length);
    offset += length + 4;

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8] ?? 0;
      colorType = data[9] ?? 0;
      const interlace = data[12] ?? 0;
      if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
        throw new Error('Only 8-bit non-interlaced RGBA PNG files are supported');
      }
    } else if (type === 'IDAT') {
      idatChunks.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
  }

  if (!width || !height || !idatChunks.length) throw new Error('PNG is missing IHDR or IDAT data');
  const inflated = inflateSync(Buffer.concat(idatChunks));
  const stride = width * RGBA_BYTES_PER_PIXEL;
  const expectedLength = (stride + 1) * height;
  if (inflated.length < expectedLength) throw new Error('PNG pixel data is truncated');
  const pixels = Buffer.alloc(stride * height);
  let inputOffset = 0;
  let outputOffset = 0;
  let previousRow = Buffer.alloc(stride);

  for (let y = 0; y < height; y += 1) {
    const filter = inflated[inputOffset] ?? 0;
    inputOffset += 1;
    const raw = inflated.subarray(inputOffset, inputOffset + stride);
    inputOffset += stride;
    const row = unfilterRow(filter, raw, previousRow, RGBA_BYTES_PER_PIXEL);
    row.copy(pixels, outputOffset);
    previousRow = Buffer.from(row);
    outputOffset += stride;
  }

  return { width, height, pixels };
}

function unfilterRow(filter: number, raw: Buffer, previous: Buffer, bytesPerPixel: number): Buffer {
  const row = Buffer.alloc(raw.length);
  for (let index = 0; index < raw.length; index += 1) {
    const left = index >= bytesPerPixel ? row[index - bytesPerPixel] ?? 0 : 0;
    const up = previous[index] ?? 0;
    const upLeft = index >= bytesPerPixel ? previous[index - bytesPerPixel] ?? 0 : 0;
    const value = raw[index] ?? 0;
    switch (filter) {
      case 0:
        row[index] = value;
        break;
      case 1:
        row[index] = (value + left) & 0xff;
        break;
      case 2:
        row[index] = (value + up) & 0xff;
        break;
      case 3:
        row[index] = (value + Math.floor((left + up) / 2)) & 0xff;
        break;
      case 4:
        row[index] = (value + paeth(left, up, upLeft)) & 0xff;
        break;
      default:
        throw new Error(`Unsupported PNG filter: ${filter}`);
    }
  }
  return row;
}

function fillImage(pixels: Buffer, color: [number, number, number, number]): void {
  for (let index = 0; index < pixels.length; index += RGBA_BYTES_PER_PIXEL) {
    pixels[index] = color[0];
    pixels[index + 1] = color[1];
    pixels[index + 2] = color[2];
    pixels[index + 3] = color[3];
  }
}

function drawScaledImage(target: Buffer, targetWidth: number, source: RgbaImage, x: number, y: number, width: number, height: number): void {
  for (let dy = 0; dy < height; dy += 1) {
    const sy = Math.min(source.height - 1, Math.floor((dy / height) * source.height));
    for (let dx = 0; dx < width; dx += 1) {
      const sx = Math.min(source.width - 1, Math.floor((dx / width) * source.width));
      const sourceOffset = (sy * source.width + sx) * RGBA_BYTES_PER_PIXEL;
      const targetOffset = ((y + dy) * targetWidth + x + dx) * RGBA_BYTES_PER_PIXEL;
      target[targetOffset] = source.pixels[sourceOffset] ?? 0;
      target[targetOffset + 1] = source.pixels[sourceOffset + 1] ?? 0;
      target[targetOffset + 2] = source.pixels[sourceOffset + 2] ?? 0;
      target[targetOffset + 3] = source.pixels[sourceOffset + 3] ?? 255;
    }
  }
}

function encodePngRgba(image: RgbaImage): Buffer {
  const stride = image.width * RGBA_BYTES_PER_PIXEL;
  const scanlines = Buffer.alloc((stride + 1) * image.height);
  for (let y = 0; y < image.height; y += 1) {
    const targetOffset = y * (stride + 1);
    scanlines[targetOffset] = 0;
    image.pixels.copy(scanlines, targetOffset + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(image.width, 0);
  ihdr.writeUInt32BE(image.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(scanlines)),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upLeftDistance = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left;
  if (upDistance <= upLeftDistance) return up;
  return upLeft;
}

const CRC_TABLE = Array.from({ length: 256 }, (_value, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  }
  return crc >>> 0;
});
