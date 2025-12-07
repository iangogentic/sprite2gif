import sharp from 'sharp';

/**
 * Analyze generated GIF frames for quality issues
 * Checks for:
 * - Frame alignment (jitter/movement)
 * - Background consistency
 * - Content centering
 */
export async function analyzeGifQuality(frameBuffers, options = {}) {
  const { verbose } = options;

  if (frameBuffers.length < 2) {
    return { quality: 'ok', issues: [] };
  }

  const issues = [];

  // Get metadata for all frames
  const frameMetas = await Promise.all(
    frameBuffers.map(buf => sharp(buf).metadata())
  );

  // Check for size consistency
  const widths = [...new Set(frameMetas.map(m => m.width))];
  const heights = [...new Set(frameMetas.map(m => m.height))];

  if (widths.length > 1 || heights.length > 1) {
    issues.push({
      type: 'size_mismatch',
      message: `Frames have inconsistent sizes: ${widths.join(',')}x${heights.join(',')}`,
      severity: 'high'
    });
  }

  // Analyze content position in each frame
  const contentBounds = await Promise.all(
    frameBuffers.map(async (buf) => {
      const { data, info } = await sharp(buf)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

      return findContentBounds(data, info.width, info.height);
    })
  );

  // Check for jitter (content position varies between frames)
  const xPositions = contentBounds.map(b => b.x);
  const yPositions = contentBounds.map(b => b.y);
  const xJitter = Math.max(...xPositions) - Math.min(...xPositions);
  const yJitter = Math.max(...yPositions) - Math.min(...yPositions);

  if (xJitter > 10 || yJitter > 10) {
    issues.push({
      type: 'frame_jitter',
      message: `Content position varies by ${xJitter}px horizontal, ${yJitter}px vertical`,
      severity: 'high',
      data: { xJitter, yJitter, contentBounds }
    });
  }

  // Check centering
  const firstBounds = contentBounds[0];
  const frameWidth = frameMetas[0].width;
  const frameHeight = frameMetas[0].height;

  const leftMargin = firstBounds.x;
  const rightMargin = frameWidth - (firstBounds.x + firstBounds.width);
  const topMargin = firstBounds.y;
  const bottomMargin = frameHeight - (firstBounds.y + firstBounds.height);

  if (Math.abs(leftMargin - rightMargin) > 20 || Math.abs(topMargin - bottomMargin) > 20) {
    issues.push({
      type: 'off_center',
      message: `Content is not centered (margins: L=${leftMargin}, R=${rightMargin}, T=${topMargin}, B=${bottomMargin})`,
      severity: 'medium'
    });
  }

  return {
    quality: issues.filter(i => i.severity === 'high').length > 0 ? 'poor' :
             issues.length > 0 ? 'fair' : 'good',
    issues,
    contentBounds,
    frameDimensions: { width: frameWidth, height: frameHeight }
  };
}

/**
 * Find the bounding box of non-transparent content in RGBA data
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

  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1
  };
}

/**
 * Detect if image has a checkered transparency pattern background
 */
export async function detectCheckeredBackground(imagePath) {
  const { data, info } = await sharp(imagePath)
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = info.width;
  const height = info.height;
  const channels = info.channels;

  // Sample corners and edges for checkered pattern
  // Checkered patterns typically alternate every 8-16 pixels
  const checkSizes = [8, 10, 12, 16];

  for (const checkSize of checkSizes) {
    let matchCount = 0;
    let totalChecks = 0;

    // Check top-left region
    for (let y = 0; y < Math.min(50, height); y++) {
      for (let x = 0; x < Math.min(50, width); x++) {
        const idx = (y * width + x) * channels;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];

        // Checkered patterns are usually light gray and white
        const isLight = r > 200 && g > 200 && b > 200;
        const isGray = r > 180 && r < 220 && Math.abs(r - g) < 10 && Math.abs(r - b) < 10;

        const expectedLight = ((Math.floor(x / checkSize) + Math.floor(y / checkSize)) % 2) === 0;

        if ((isLight && expectedLight) || (isGray && !expectedLight)) {
          matchCount++;
        }
        totalChecks++;
      }
    }

    if (matchCount / totalChecks > 0.7) {
      return { hasCheckered: true, checkSize };
    }
  }

  return { hasCheckered: false };
}

/**
 * Remove checkered background by replacing with transparency
 */
export async function removeCheckeredBackground(imageBuffer, checkSize = 12) {
  const { data, info } = await sharp(imageBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = info.width;
  const height = info.height;
  const newData = Buffer.from(data);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];

      // Detect checkered pattern colors with tolerance for JPEG compression
      // White-ish: RGB values all > 248
      const isCheckeredLight = r > 248 && g > 248 && b > 248;
      // Gray-ish: RGB in 185-220 range, values close together
      const isCheckeredGray = r > 185 && r < 220 &&
                              g > 185 && g < 220 &&
                              b > 180 && b < 215 &&
                              Math.abs(r - g) < 15 && Math.abs(r - b) < 20;

      if (isCheckeredLight || isCheckeredGray) {
        // Make transparent
        newData[idx + 3] = 0;
      }
    }
  }

  return sharp(newData, {
    raw: {
      width,
      height,
      channels: 4
    }
  }).png().toBuffer();
}
