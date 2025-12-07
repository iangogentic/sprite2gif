import sharp from 'sharp';

/**
 * Extract individual frames from a sprite sheet
 *
 * @param {string} imagePath - Path to the sprite sheet image
 * @param {Array} frames - Array of frame objects with { x, y, width, height }
 * @returns {Promise<Array>} Array of PNG buffers for each frame
 */
export async function extractFrames(imagePath, frames) {
  const image = sharp(imagePath);
  const frameBuffers = [];

  for (const frame of frames) {
    const buffer = await image
      .clone()
      .extract({
        left: frame.x,
        top: frame.y,
        width: frame.width,
        height: frame.height
      })
      .png()
      .toBuffer();

    frameBuffers.push(buffer);
  }

  return frameBuffers;
}
