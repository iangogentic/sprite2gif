import sharp from 'sharp';
import fs from 'fs';
import path from 'path';

/**
 * Create an animated APNG from frame buffers
 *
 * APNG supports full alpha transparency (unlike GIF's 1-bit transparency)
 * which eliminates fringe artifacts around edges.
 *
 * @param {Array<Buffer>} frameBuffers - Array of PNG buffers
 * @param {string} outputPath - Output APNG path
 * @param {Object} options - APNG options
 */
export async function createApng(frameBuffers, outputPath, options) {
  const {
    delay = 100,
    repeat = 0, // 0 = loop forever
  } = options;

  // Ensure output directory exists
  const outputDir = path.dirname(outputPath);
  if (outputDir && !fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Find the largest frame dimensions to normalize all frames
  let maxWidth = 0;
  let maxHeight = 0;

  for (const buffer of frameBuffers) {
    const meta = await sharp(buffer).metadata();
    maxWidth = Math.max(maxWidth, meta.width);
    maxHeight = Math.max(maxHeight, meta.height);
  }

  // Normalize all frames to the same dimensions
  const normalizedFrames = [];
  for (const buffer of frameBuffers) {
    const meta = await sharp(buffer).metadata();

    let normalized;
    if (meta.width !== maxWidth || meta.height !== maxHeight) {
      // Center the frame on a transparent canvas
      normalized = await sharp(buffer)
        .resize(maxWidth, maxHeight, {
          fit: 'contain',
          background: { r: 0, g: 0, b: 0, alpha: 0 }
        })
        .png()
        .toBuffer();
    } else {
      normalized = buffer;
    }
    normalizedFrames.push(normalized);
  }

  // Create the APNG manually using the APNG chunk structure
  // (sharp doesn't directly support creating multi-frame APNGs from separate buffers)
  const apngBuffer = await createApngFromFrames(normalizedFrames, {
    delay,
    repeat,
    width: maxWidth,
    height: maxHeight
  });

  fs.writeFileSync(outputPath, apngBuffer);

  return {
    path: outputPath,
    size: apngBuffer.length,
    frames: frameBuffers.length,
    width: maxWidth,
    height: maxHeight
  };
}

/**
 * Create APNG buffer from frame buffers
 * APNG format: PNG signature + IHDR + acTL + (fcTL + IDAT/fdAT)* + IEND
 */
async function createApngFromFrames(frameBuffers, options) {
  const { delay, repeat, width, height } = options;

  // Parse each PNG to extract IDAT chunks
  const frames = [];
  for (const buf of frameBuffers) {
    const parsed = parsePng(buf);
    frames.push(parsed);
  }

  const chunks = [];

  // PNG Signature
  chunks.push(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));

  // IHDR chunk (from first frame)
  chunks.push(frames[0].ihdr);

  // acTL chunk (animation control)
  const acTL = createAcTL(frames.length, repeat);
  chunks.push(acTL);

  // For each frame: fcTL + image data
  let sequenceNumber = 0;

  for (let i = 0; i < frames.length; i++) {
    // fcTL (frame control)
    const fcTL = createFcTL(sequenceNumber++, width, height, delay);
    chunks.push(fcTL);

    if (i === 0) {
      // First frame uses IDAT
      for (const idat of frames[i].idats) {
        chunks.push(idat);
      }
    } else {
      // Subsequent frames use fdAT
      for (const idat of frames[i].idats) {
        const fdAT = convertIdatToFdat(idat, sequenceNumber++);
        chunks.push(fdAT);
      }
    }
  }

  // IEND chunk
  chunks.push(frames[0].iend);

  return Buffer.concat(chunks);
}

/**
 * Parse PNG and extract chunks
 */
function parsePng(buffer) {
  const result = {
    ihdr: null,
    idats: [],
    iend: null
  };

  let offset = 8; // Skip PNG signature

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const chunkEnd = offset + 12 + length;
    const chunk = buffer.slice(offset, chunkEnd);

    if (type === 'IHDR') {
      result.ihdr = chunk;
    } else if (type === 'IDAT') {
      result.idats.push(chunk);
    } else if (type === 'IEND') {
      result.iend = chunk;
    }

    offset = chunkEnd;
  }

  return result;
}

/**
 * Create acTL chunk (animation control)
 */
function createAcTL(numFrames, numPlays) {
  const data = Buffer.alloc(8);
  data.writeUInt32BE(numFrames, 0);
  data.writeUInt32BE(numPlays, 4);
  return createChunk('acTL', data);
}

/**
 * Create fcTL chunk (frame control)
 */
function createFcTL(sequenceNumber, width, height, delayMs) {
  const data = Buffer.alloc(26);
  let offset = 0;

  data.writeUInt32BE(sequenceNumber, offset); offset += 4;
  data.writeUInt32BE(width, offset); offset += 4;
  data.writeUInt32BE(height, offset); offset += 4;
  data.writeUInt32BE(0, offset); offset += 4; // x_offset
  data.writeUInt32BE(0, offset); offset += 4; // y_offset
  data.writeUInt16BE(delayMs, offset); offset += 2; // delay_num (ms)
  data.writeUInt16BE(1000, offset); offset += 2; // delay_den (1000 = milliseconds)
  data.writeUInt8(0, offset); offset += 1; // dispose_op (0 = none)
  data.writeUInt8(0, offset); // blend_op (0 = source)

  return createChunk('fcTL', data);
}

/**
 * Convert IDAT chunk to fdAT chunk
 */
function convertIdatToFdat(idatChunk, sequenceNumber) {
  // Extract IDAT data (skip length, type, and CRC)
  const length = idatChunk.readUInt32BE(0);
  const idatData = idatChunk.slice(8, 8 + length);

  // fdAT = sequence_number (4 bytes) + IDAT data
  const fdatData = Buffer.alloc(4 + idatData.length);
  fdatData.writeUInt32BE(sequenceNumber, 0);
  idatData.copy(fdatData, 4);

  return createChunk('fdAT', fdatData);
}

/**
 * Create a PNG chunk with CRC
 */
function createChunk(type, data) {
  const chunk = Buffer.alloc(12 + data.length);
  let offset = 0;

  // Length
  chunk.writeUInt32BE(data.length, offset);
  offset += 4;

  // Type
  chunk.write(type, offset, 4, 'ascii');
  offset += 4;

  // Data
  data.copy(chunk, offset);
  offset += data.length;

  // CRC (over type + data)
  const crcData = chunk.slice(4, 8 + data.length);
  const crc = crc32(crcData);
  chunk.writeUInt32BE(crc >>> 0, offset);

  return chunk;
}

/**
 * CRC32 calculation for PNG chunks
 */
function crc32(buffer) {
  let crc = 0xFFFFFFFF;

  for (let i = 0; i < buffer.length; i++) {
    crc ^= buffer[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }

  return crc ^ 0xFFFFFFFF;
}
