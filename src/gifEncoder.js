import GIFEncoder from 'gif-encoder-2';
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';

/**
 * Create an animated GIF from frame buffers
 *
 * Handles variable-sized frames by normalizing to a consistent size
 *
 * @param {Array<Buffer>} frameBuffers - Array of PNG buffers
 * @param {string} outputPath - Output GIF path
 * @param {Object} options - GIF options
 */
export async function createGif(frameBuffers, outputPath, options) {
  const {
    width,
    height,
    delay = 100,
    repeat = 0,
    quality = 10,
    normalize = true // Resize all frames to same dimensions
  } = options;

  // Ensure output directory exists
  const outputDir = path.dirname(outputPath);
  if (outputDir && !fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Determine final frame dimensions
  let finalWidth = width;
  let finalHeight = height;

  if (!finalWidth || !finalHeight) {
    // Get dimensions from first frame
    const firstMeta = await sharp(frameBuffers[0]).metadata();
    finalWidth = finalWidth || firstMeta.width;
    finalHeight = finalHeight || firstMeta.height;
  }

  // If normalizing, find the largest frame dimensions
  if (normalize) {
    for (const buffer of frameBuffers) {
      const meta = await sharp(buffer).metadata();
      finalWidth = Math.max(finalWidth, meta.width);
      finalHeight = Math.max(finalHeight, meta.height);
    }
  }

  // Create encoder
  // 'octree' is better for pixel art/simple graphics (like sprites)
  // 'neuquant' is better for photos/complex images
  const encoder = new GIFEncoder(finalWidth, finalHeight, 'octree');

  // Configure
  encoder.setDelay(delay);
  encoder.setRepeat(repeat); // 0 = loop forever, -1 = no loop, N = loop N times
  encoder.setQuality(quality);
  encoder.setTransparent(0x00000000);

  encoder.start();

  // Process each frame
  for (let i = 0; i < frameBuffers.length; i++) {
    const buffer = frameBuffers[i];

    // Normalize frame to target dimensions
    let processedBuffer = buffer;

    const meta = await sharp(buffer).metadata();
    if (meta.width !== finalWidth || meta.height !== finalHeight) {
      // Resize/pad frame to match target dimensions
      processedBuffer = await sharp(buffer)
        .resize(finalWidth, finalHeight, {
          fit: 'contain',
          background: { r: 0, g: 0, b: 0, alpha: 0 }
        })
        .png()
        .toBuffer();
    }

    // Convert to raw RGBA
    const { data, info } = await sharp(processedBuffer)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    // GIF only supports binary transparency - convert semi-transparent to fully transparent
    // Use a high threshold to get clean edges
    const width = info.width;
    const height = info.height;

    for (let j = 0; j < data.length; j += 4) {
      const alpha = data[j + 3];

      // Make semi-transparent pixels fully transparent
      if (alpha < 240) {
        data[j] = 0;     // R
        data[j + 1] = 0; // G
        data[j + 2] = 0; // B
        data[j + 3] = 0; // A
      }
    }

    // Remove all very light gray/white pixels that look like background remnants
    // These are characterized by: high brightness, low saturation, neutral color
    for (let j = 0; j < data.length; j += 4) {
      const r = data[j], g = data[j + 1], b = data[j + 2], a = data[j + 3];

      if (a > 0) {
        const maxC = Math.max(r, g, b);
        const minC = Math.min(r, g, b);
        const spread = maxC - minC;

        // Very neutral (spread < 35) and bright (> 165) = likely background
        // This catches white, light gray, and medium gray from checkered pattern
        if (spread < 35 && maxC > 165) {
          data[j] = 0;
          data[j + 1] = 0;
          data[j + 2] = 0;
          data[j + 3] = 0;
        }
      }
    }

    // Multiple passes of fringe removal for edge cleanup
    for (let pass = 0; pass < 2; pass++) {
      const tempAlpha = new Uint8Array(width * height);

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = (y * width + x) * 4;
          const r = data[idx], g = data[idx + 1], b = data[idx + 2], a = data[idx + 3];

          if (a > 0) {
            const maxC = Math.max(r, g, b);
            const minC = Math.min(r, g, b);
            const spread = maxC - minC;
            // Light neutral pixels at edges
            const isLightNeutral = spread < 40 && maxC > 160;

            if (isLightNeutral) {
              let touchesTransparent = false;
              for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                  if (dx === 0 && dy === 0) continue;
                  const nx = x + dx, ny = y + dy;
                  if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
                    touchesTransparent = true;
                  } else {
                    const nidx = (ny * width + nx) * 4;
                    if (data[nidx + 3] === 0) {
                      touchesTransparent = true;
                    }
                  }
                  if (touchesTransparent) break;
                }
                if (touchesTransparent) break;
              }

              if (touchesTransparent) {
                tempAlpha[y * width + x] = 1;
              }
            }
          }
        }
      }

      for (let j = 0; j < tempAlpha.length; j++) {
        if (tempAlpha[j] === 1) {
          const idx = j * 4;
          data[idx] = 0;
          data[idx + 1] = 0;
          data[idx + 2] = 0;
          data[idx + 3] = 0;
        }
      }
    }

    encoder.addFrame(data);
  }

  encoder.finish();

  // Write output
  const gifBuffer = encoder.out.getData();
  fs.writeFileSync(outputPath, gifBuffer);

  return {
    path: outputPath,
    size: gifBuffer.length,
    frames: frameBuffers.length,
    width: finalWidth,
    height: finalHeight
  };
}
