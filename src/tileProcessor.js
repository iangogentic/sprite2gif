import sharp from 'sharp';
import { removeBackground } from '@imgly/background-removal-node';

/**
 * Post-process an AI-generated tile image to exact dimensions
 *
 * AI image generators (like Gemini) return large images (e.g., 1456x720)
 * with opaque backgrounds. This function:
 * 1. Removes background using AI
 * 2. Cleans up gray/white artifacts
 * 3. Crops to content bounds
 * 4. Resizes to exact target dimensions
 * 5. Ensures PNG format with proper transparency
 *
 * @param {Buffer} inputBuffer - Raw image buffer from AI
 * @param {Object} options - Processing options
 * @param {number} options.targetWidth - Target width in pixels (e.g., 64)
 * @param {number} options.targetHeight - Target height in pixels (e.g., 32)
 * @param {boolean} options.removeBg - Remove background using AI (default: true)
 * @param {boolean} options.cropToContent - Whether to crop to content bounds (default: true)
 * @param {boolean} options.verbose - Log processing details
 * @returns {Promise<Buffer>} Processed PNG buffer at exact dimensions
 */
export async function processTileImage(inputBuffer, options = {}) {
  const {
    targetWidth = 64,
    targetHeight = 32,
    removeBg = true,
    cropToContent = true,
    verbose = false
  } = options;

  // Get original dimensions
  const metadata = await sharp(inputBuffer).metadata();

  if (verbose) {
    console.log(`    Original: ${metadata.width}x${metadata.height}`);
  }

  let processedBuffer = inputBuffer;

  // Step 1: Convert to PNG with alpha channel
  processedBuffer = await sharp(processedBuffer)
    .ensureAlpha()
    .png()
    .toBuffer();

  // Step 2: Remove background using AI
  if (removeBg) {
    if (verbose) {
      console.log(`    Removing background...`);
    }

    try {
      // Convert Buffer to Blob (library requires Blob input)
      const inputBlob = new Blob([processedBuffer], { type: 'image/png' });
      const resultBlob = await removeBackground(inputBlob);
      const arrayBuffer = await resultBlob.arrayBuffer();
      processedBuffer = Buffer.from(arrayBuffer);
    } catch (err) {
      if (verbose) {
        console.log(`    Background removal failed: ${err.message}`);
      }
      // Continue with original if removal fails
    }
  }

  // Step 3: Clean up gray/white artifacts left by AI removal
  processedBuffer = await cleanupGrayArtifacts(processedBuffer, verbose);

  // Step 4: Crop to content bounds if requested
  if (cropToContent) {
    const contentBounds = await findContentBounds(processedBuffer);

    if (contentBounds) {
      if (verbose) {
        console.log(`    Content bounds: ${contentBounds.width}x${contentBounds.height} at (${contentBounds.left},${contentBounds.top})`);
      }

      processedBuffer = await sharp(processedBuffer)
        .extract({
          left: contentBounds.left,
          top: contentBounds.top,
          width: contentBounds.width,
          height: contentBounds.height
        })
        .toBuffer();
    }
  }

  // Step 5: Resize to target dimensions
  // Use 'contain' to preserve aspect ratio, then extend with transparency to exact size
  processedBuffer = await sharp(processedBuffer)
    .resize(targetWidth, targetHeight, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .png()
    .toBuffer();

  if (verbose) {
    const finalMeta = await sharp(processedBuffer).metadata();
    console.log(`    Final: ${finalMeta.width}x${finalMeta.height}`);
  }

  return processedBuffer;
}

/**
 * Clean up gray/white artifacts from background removal
 * @param {Buffer} buffer - Image buffer
 * @param {boolean} verbose - Log details
 * @returns {Promise<Buffer>} Cleaned buffer
 */
async function cleanupGrayArtifacts(buffer, verbose = false) {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  let cleaned = 0;

  for (let i = 0; i < data.length; i += channels) {
    const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];

    // Skip already transparent pixels
    if (a < 10) continue;

    // Detect checkered pattern colors (light and dark gray)
    const isLightGray = r > 180 && r < 210 && Math.abs(r - g) < 10 && Math.abs(r - b) < 10;
    const isDarkGray = r > 140 && r < 175 && Math.abs(r - g) < 10 && Math.abs(r - b) < 10;
    const isWhiteish = r > 230 && g > 230 && b > 230;

    // Also detect the specific checkered pattern colors
    const isCheckerLight = r > 190 && r < 210 && g > 190 && g < 210 && b > 190 && b < 210;
    const isCheckerDark = r > 150 && r < 170 && g > 150 && g < 170 && b > 150 && b < 170;

    if (isWhiteish || isLightGray || isDarkGray || isCheckerLight || isCheckerDark) {
      data[i + 3] = 0; // Make transparent
      cleaned++;
    }
  }

  if (verbose && cleaned > 0) {
    console.log(`    Cleaned ${cleaned} gray/white pixels`);
  }

  return sharp(data, { raw: { width, height, channels } })
    .png()
    .toBuffer();
}

/**
 * Find the bounding box of non-transparent content in an image
 * @param {Buffer} buffer - PNG image buffer with alpha channel
 * @returns {Promise<Object|null>} { left, top, width, height } or null if all transparent
 */
export async function findContentBounds(buffer) {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;

  let minX = width, minY = height, maxX = 0, maxY = 0;
  let hasContent = false;

  // Scan for non-transparent pixels (alpha > threshold)
  const alphaThreshold = 10;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * channels;
      const alpha = data[idx + 3]; // Alpha channel

      if (alpha > alphaThreshold) {
        hasContent = true;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (!hasContent) {
    return null;
  }

  // Add small padding (2px) to avoid cutting edges
  const padding = 2;
  minX = Math.max(0, minX - padding);
  minY = Math.max(0, minY - padding);
  maxX = Math.min(width - 1, maxX + padding);
  maxY = Math.min(height - 1, maxY + padding);

  return {
    left: minX,
    top: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1
  };
}

/**
 * Validate that a tile buffer has the expected dimensions
 * @param {Buffer} buffer - Image buffer to validate
 * @param {number} expectedWidth - Expected width
 * @param {number} expectedHeight - Expected height
 * @returns {Promise<Object>} { valid: boolean, actualWidth, actualHeight, message }
 */
export async function validateTileDimensions(buffer, expectedWidth, expectedHeight) {
  const metadata = await sharp(buffer).metadata();

  const valid = metadata.width === expectedWidth && metadata.height === expectedHeight;

  return {
    valid,
    actualWidth: metadata.width,
    actualHeight: metadata.height,
    expectedWidth,
    expectedHeight,
    message: valid
      ? `Tile is ${expectedWidth}x${expectedHeight} as expected`
      : `Tile is ${metadata.width}x${metadata.height}, expected ${expectedWidth}x${expectedHeight}`
  };
}

/**
 * Process multiple tiles in batch
 * @param {Array} tiles - Array of { name, buffer } objects
 * @param {Object} options - Processing options (targetWidth, targetHeight, verbose)
 * @returns {Promise<Array>} Array of { name, buffer } with processed buffers
 */
export async function processTileBatch(tiles, options = {}) {
  const results = [];

  for (const tile of tiles) {
    const processedBuffer = await processTileImage(tile.buffer, options);
    results.push({
      name: tile.name,
      buffer: processedBuffer
    });
  }

  return results;
}
