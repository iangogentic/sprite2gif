import puppeteer from 'puppeteer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Detect frames in a sprite sheet using Puppeteer + OpenCV.js
 *
 * This approach:
 * 1. Launches headless browser
 * 2. Loads OpenCV.js (battle-tested computer vision library)
 * 3. Uses cv.findContours for accurate sprite boundary detection
 * 4. Returns frame coordinates for extraction
 */
export async function detectFrames(imagePath, options = {}) {
  const { rows: manualRows, cols: manualCols, verbose, debug } = options;

  // Read image as base64
  const imageBuffer = fs.readFileSync(imagePath);
  const base64 = imageBuffer.toString('base64');
  const mimeType = imagePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
  const dataUrl = `data:${mimeType};base64,${base64}`;

  // If manual rows/cols specified, skip OpenCV detection
  if (manualRows && manualCols) {
    const sharp = (await import('sharp')).default;
    const metadata = await sharp(imagePath).metadata();
    return createUniformGrid(metadata.width, metadata.height, manualRows, manualCols);
  }

  if (verbose) {
    console.log('  Launching Puppeteer...');
  }

  // Launch browser
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();

    // Suppress console messages unless in debug mode
    if (verbose) {
      page.on('console', msg => console.log('  [Browser]', msg.text()));
    }

    // Load the OpenCV processor page
    const htmlPath = path.join(__dirname, 'opencv-processor.html');
    await page.goto(`file://${htmlPath}`);

    // Wait for OpenCV.js to load
    if (verbose) {
      console.log('  Waiting for OpenCV.js to load...');
    }

    await page.waitForFunction('window.opencvReady === true', {
      timeout: 30000
    });

    if (verbose) {
      console.log('  OpenCV.js ready, analyzing sprite sheet...');
    }

    // Run detection
    const result = await page.evaluate(async (dataUrl, debug) => {
      return await window.analyzeSprite(dataUrl, { debug });
    }, dataUrl, debug);

    if (verbose) {
      console.log(`  Detection method: ${result.method}`);
      console.log(`  Grid info: ${result.gridInfo.cols}x${result.gridInfo.rows} (uniform: ${result.gridInfo.isUniform})`);
    }

    // Take debug screenshot if requested
    if (debug) {
      const debugPath = imagePath.replace(/\.[^.]+$/, '_debug.png');
      await page.screenshot({ path: debugPath, fullPage: true });
      if (verbose) {
        console.log(`  Debug screenshot saved: ${debugPath}`);
      }
    }

    // Validate and normalize results
    if (!result.frames || result.frames.length === 0) {
      throw new Error('No frames detected in sprite sheet');
    }

    // Calculate consistent frame dimensions
    const frameWidth = result.gridInfo.avgFrameWidth ||
      Math.round(result.frames.reduce((sum, f) => sum + f.width, 0) / result.frames.length);
    const frameHeight = result.gridInfo.avgFrameHeight ||
      Math.round(result.frames.reduce((sum, f) => sum + f.height, 0) / result.frames.length);

    return {
      width: result.imageWidth,
      height: result.imageHeight,
      rows: result.gridInfo.rows,
      cols: result.gridInfo.cols,
      frameWidth,
      frameHeight,
      frames: result.frames,
      method: result.method,
      isUniform: result.gridInfo.isUniform
    };

  } finally {
    await browser.close();
  }
}

/**
 * Create a uniform grid of frames (for manual specification)
 */
function createUniformGrid(width, height, rows, cols) {
  const frameWidth = Math.floor(width / cols);
  const frameHeight = Math.floor(height / rows);
  const frames = [];

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      frames.push({
        x: col * frameWidth,
        y: row * frameHeight,
        width: frameWidth,
        height: frameHeight
      });
    }
  }

  return {
    width,
    height,
    rows,
    cols,
    frameWidth,
    frameHeight,
    frames,
    method: 'manual',
    isUniform: true
  };
}

/**
 * Generate a validation image showing detected frames overlaid on original
 * Saves to disk and returns the path
 */
export async function generateValidationImage(imagePath, frames, outputPath) {
  const imageBuffer = fs.readFileSync(imagePath);
  const base64 = imageBuffer.toString('base64');
  const mimeType = imagePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
  const dataUrl = `data:${mimeType};base64,${base64}`;

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    const htmlPath = path.join(__dirname, 'opencv-processor.html');
    await page.goto(`file://${htmlPath}`);

    await page.waitForFunction('window.opencvReady === true', { timeout: 30000 });

    const validationDataUrl = await page.evaluate(async (dataUrl, frames) => {
      return await window.generateValidationImage(dataUrl, frames);
    }, dataUrl, frames);

    // Convert base64 to buffer and save
    const base64Data = validationDataUrl.replace(/^data:image\/png;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    fs.writeFileSync(outputPath, buffer);

    return outputPath;
  } finally {
    await browser.close();
  }
}
