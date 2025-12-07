import sharp from 'sharp';
import { removeBackground } from '@imgly/background-removal-node';
import {
  analyzeGifQuality,
  detectCheckeredBackground,
  removeCheckeredBackground
} from './analyzer.js';

/**
 * Process frames to fix common issues:
 * - Remove backgrounds using AI
 * - Align content to consistent position
 * - Normalize frame sizes
 */
export async function processFrames(frameBuffers, options = {}) {
  const { verbose, removeBg = true, alignContent = true, useAI = true } = options;

  let processed = [...frameBuffers];

  // Step 1: Remove background
  if (removeBg) {
    if (useAI) {
      // Use AI-powered background removal
      if (verbose) console.log(`  Using AI background removal (first run downloads model ~40MB)...`);

      processed = await Promise.all(
        processed.map(async (buf, i) => {
          try {
            // Convert Buffer to Blob (library requires Blob input)
            const inputBlob = new Blob([buf], { type: 'image/png' });
            const resultBlob = await removeBackground(inputBlob);
            const arrayBuffer = await resultBlob.arrayBuffer();
            if (verbose && i === 0) console.log(`  AI model loaded, processing frames...`);
            return Buffer.from(arrayBuffer);
          } catch (err) {
            if (verbose) console.log(`  AI removal failed for frame ${i}: ${err.message}, using fallback...`);
            // Fallback to checkered pattern removal
            return removeCheckeredBackground(buf, 12);
          }
        })
      );

      // Clean up any white/gray artifacts left by AI removal
      processed = await Promise.all(
        processed.map(async (buf) => {
          const { data, info } = await sharp(buf)
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });

          // Remove near-white and light gray pixels (remnants of checkered bg)
          for (let i = 0; i < data.length; i += 4) {
            const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];

            // If pixel is white-ish or light gray-ish, make it transparent
            const isWhiteish = r > 230 && g > 230 && b > 230;
            const isLightGray = r > 175 && r < 225 && Math.abs(r - g) < 15 && Math.abs(r - b) < 15;

            if (isWhiteish || isLightGray) {
              data[i + 3] = 0; // Make transparent
            }
          }

          return sharp(data, {
            raw: { width: info.width, height: info.height, channels: 4 }
          }).png().toBuffer();
        })
      );

      if (verbose) console.log(`  Background removed and cleaned from ${processed.length} frames`);
    } else {
      // Use simple checkered pattern detection
      const firstFrame = processed[0];
      const bgCheck = await detectCheckeredBackgroundFromBuffer(firstFrame);

      if (bgCheck.hasCheckered) {
        if (verbose) console.log(`  Detected checkered background, removing...`);

        processed = await Promise.all(
          processed.map(buf => removeCheckeredBackground(buf, bgCheck.checkSize))
        );

        if (verbose) console.log(`  Background removed from ${processed.length} frames`);
      }
    }
  }

  // Step 2: Analyze content bounds and centers in each frame (combined for efficiency)
  const frameAnalysis = await Promise.all(
    processed.map(async (buf) => {
      const { data, info } = await sharp(buf)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

      return {
        bounds: findContentBounds(data, info.width, info.height),
        center: findContentCenter(data, info.width, info.height)
      };
    })
  );

  const contentBounds = frameAnalysis.map(a => a.bounds);

  // Step 3: Align content by centering each sprite
  if (alignContent) {
    const centers = frameAnalysis.map(a => a.center);

    const xCenters = centers.map(c => c.x);
    const yCenters = centers.map(c => c.y);
    const xJitter = Math.max(...xCenters) - Math.min(...xCenters);
    const yJitter = Math.max(...yCenters) - Math.min(...yCenters);

    if (xJitter > 10 || yJitter > 10) {
      if (verbose) console.log(`  Fixing sprite jitter (x: ${xJitter.toFixed(0)}px, y: ${yJitter.toFixed(0)}px)...`);

      // Calculate target center (average of all centers)
      const targetX = xCenters.reduce((a, b) => a + b, 0) / xCenters.length;
      const targetY = yCenters.reduce((a, b) => a + b, 0) / yCenters.length;

      // Find the maximum content bounds when centered
      const maxContentWidth = Math.max(...contentBounds.map(b => b.width));
      const maxContentHeight = Math.max(...contentBounds.map(b => b.height));

      // Get actual frame dimensions to ensure canvas is large enough
      const frameMetas = await Promise.all(processed.map(buf => sharp(buf).metadata()));
      const maxFrameWidth = Math.max(...frameMetas.map(m => m.width));
      const maxFrameHeight = Math.max(...frameMetas.map(m => m.height));

      // Calculate canvas size needed to fit all centered sprites (must be at least as large as largest frame)
      const canvasWidth = Math.max(maxFrameWidth, maxContentWidth + Math.ceil(xJitter) + 20);
      const canvasHeight = Math.max(maxFrameHeight, maxContentHeight + Math.ceil(yJitter) + 20);

      // Center each sprite
      processed = await Promise.all(
        processed.map(async (buf, i) => {
          const meta = await sharp(buf).metadata();
          const center = centers[i];
          const bounds = contentBounds[i];

          // Calculate offset to center this sprite
          const offsetX = Math.round((canvasWidth / 2) - center.x);
          const offsetY = Math.round((canvasHeight / 2) - center.y);

          // Create new canvas and composite the frame
          return sharp({
            create: {
              width: canvasWidth,
              height: canvasHeight,
              channels: 4,
              background: { r: 0, g: 0, b: 0, alpha: 0 }
            }
          })
          .composite([{
            input: buf,
            left: Math.max(0, offsetX),
            top: Math.max(0, offsetY)
          }])
          .png()
          .toBuffer();
        })
      );

      if (verbose) console.log(`  Centered sprites on ${canvasWidth}x${canvasHeight}px canvas`);
    }
  }

  // Step 4: Normalize sizes (ensure all frames are identical size)
  const metas = await Promise.all(processed.map(buf => sharp(buf).metadata()));
  const maxWidth = Math.max(...metas.map(m => m.width));
  const maxHeight = Math.max(...metas.map(m => m.height));

  const needsNormalization = metas.some(m => m.width !== maxWidth || m.height !== maxHeight);

  if (needsNormalization) {
    if (verbose) console.log(`  Normalizing frame sizes to ${maxWidth}x${maxHeight}px...`);

    processed = await Promise.all(
      processed.map(async (buf) => {
        const meta = await sharp(buf).metadata();

        if (meta.width === maxWidth && meta.height === maxHeight) {
          return buf;
        }

        // Extend canvas to match max size, centering content
        return sharp(buf)
          .extend({
            top: Math.floor((maxHeight - meta.height) / 2),
            bottom: Math.ceil((maxHeight - meta.height) / 2),
            left: Math.floor((maxWidth - meta.width) / 2),
            right: Math.ceil((maxWidth - meta.width) / 2),
            background: { r: 0, g: 0, b: 0, alpha: 0 }
          })
          .png()
          .toBuffer();
      })
    );
  }

  return processed;
}

/**
 * Detect checkered background from buffer
 */
async function detectCheckeredBackgroundFromBuffer(buffer) {
  const { data, info } = await sharp(buffer)
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = info.width;
  const height = info.height;
  const channels = info.channels;

  const checkSizes = [8, 10, 12, 16];

  for (const checkSize of checkSizes) {
    let matchCount = 0;
    let totalChecks = 0;

    for (let y = 0; y < Math.min(50, height); y++) {
      for (let x = 0; x < Math.min(50, width); x++) {
        const idx = (y * width + x) * channels;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];

        // More lenient detection for JPEG artifacts
        // White-ish: > 250 (with some tolerance for compression)
        const isLight = r > 250 && g > 250 && b > 250;
        // Gray-ish: 185-220 range, similar RGB values
        const isGray = r > 185 && r < 220 && Math.abs(r - g) < 15 && Math.abs(r - b) < 15;

        const expectedLight = ((Math.floor(x / checkSize) + Math.floor(y / checkSize)) % 2) === 0;

        if ((isLight && expectedLight) || (isGray && !expectedLight)) {
          matchCount++;
        }
        totalChecks++;
      }
    }

    // Lower threshold since JPEG compression adds noise
    if (matchCount / totalChecks > 0.5) {
      return { hasCheckered: true, checkSize };
    }
  }

  return { hasCheckered: false };
}

/**
 * Find center of mass of non-transparent content
 */
function findContentCenter(data, width, height) {
  let totalX = 0;
  let totalY = 0;
  let count = 0;
  const ALPHA_THRESHOLD = 128;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const alpha = data[idx + 3];

      if (alpha > ALPHA_THRESHOLD) {
        totalX += x;
        totalY += y;
        count++;
      }
    }
  }

  return {
    x: count > 0 ? totalX / count : width / 2,
    y: count > 0 ? totalY / count : height / 2
  };
}

/**
 * Find content bounds in RGBA data
 */
function findContentBounds(data, width, height) {
  let minX = width, maxX = 0;
  let minY = height, maxY = 0;
  const ALPHA_THRESHOLD = 20;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const alpha = data[idx + 3];

      if (alpha > ALPHA_THRESHOLD) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  }

  if (minX > maxX || minY > maxY) {
    return { x: 0, y: 0, width: width, height: height };
  }

  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1
  };
}
