import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { getTemplate, generateLayout, getUniqueTileTypes, validateLayout } from './layout.js';
import { createAtlas } from './atlas.js';
import { generateTiledMap, generateTilesetJSON } from './tiled.js';
import { processTileImage } from './tileProcessor.js';

/**
 * GPU Cats Asset Factory - Sprite Sheet Generator
 *
 * Uses Google Gemini image generation to create consistent sprite sheet animations
 * from reference images. Key features:
 * - Reference image FIRST for character consistency
 * - Multi-turn chat for animation sets (maintains context)
 * - Proper sprite sheet grid prompting
 *
 * Model: gemini-3-pro-image-preview (Nano Banana Pro - high-quality image generation)
 */

const IMAGE_GEN_MODEL = 'gemini-3-pro-image-preview';

// ============================================================================
// TILE SHEET GENERATION (DEFAULT)
// ============================================================================
// Generates all tiles in ONE AI call for guaranteed style consistency.
// All tiles share the same colors, textures, and aesthetic because they're
// created together in a single image generation request.
//
// Functions:
//   - generateTilesetSheet(): Creates the unified tileset sprite sheet
//   - extractTilesFromSheet(): Extracts individual tiles from the sheet
//   - generateRoomWithSheet(): Main entry point - orchestrates the full pipeline
// ============================================================================

/**
 * Generate a complete tileset as a single sprite sheet
 * This ensures all tiles share the same style, colors, and aesthetic
 *
 * @param {string} theme - Theme description (e.g., "wooden office")
 * @param {Object} options - Generation options
 * @returns {Promise<Buffer>} PNG buffer of the tileset sheet
 */
export async function generateTilesetSheet(theme, options = {}) {
  const {
    style = 'isometric pixel art',
    apiKey = process.env.GEMINI_API_KEY,
    verbose = false
  } = options;

  if (!apiKey) {
    throw new Error('GEMINI_API_KEY environment variable is required');
  }

  const ai = new GoogleGenAI({ apiKey });

  // Sheet layout: 7 tiles in a row, each 64x64
  // [floor][wall-n][wall-w][corner-nw][corner-ne][corner-sw][corner-se]
  const sheetWidth = 448;  // 7 × 64
  const sheetHeight = 64;

  const prompt = `Generate a COMPLETE ISOMETRIC TILESET SPRITE SHEET for a "${theme}" room.

OUTPUT: A single ${sheetWidth}x${sheetHeight} pixel image containing 7 tiles in a row.

TILE LAYOUT (left to right, each tile is 64x64 pixels):
1. FLOOR TILE (position 0-63): Diamond-shaped floor, 64x32 pixels centered at bottom of 64x64 cell
2. NORTH WALL (position 64-127): Back wall running upper-left to lower-right, interior face visible
3. WEST WALL (position 128-191): Back wall running upper-right to lower-left, interior face visible
4. NW CORNER (position 192-255): Back corner where north and west walls meet, vertex points toward viewer
5. NE CORNER (position 256-319): Right corner connecting to north wall
6. SW CORNER (position 320-383): Left corner connecting to west wall
7. SE CORNER (position 384-447): Front corner (minimal, floor-level)

CRITICAL STYLE REQUIREMENTS:
- ALL tiles must share the EXACT SAME color palette, wood grain style, and lighting
- Isometric angle: 2:1 pixel ratio (26.57 degrees)
- Light source: top-left
- Theme: ${theme} - use appropriate materials (wood paneling, etc.)
- Style: ${style}

WALL REQUIREMENTS:
- Walls show INTERIOR surfaces (you're inside the room looking at the walls)
- Walls are SOLID panels, not fences or railings
- Walls have HEIGHT (full 64px tall)
- Wood grain/paneling should be consistent between walls and corners

FLOOR REQUIREMENT:
- Diamond shape fitting in bottom 32px of the 64px cell
- Same wood style as walls

CORNER REQUIREMENTS:
- Two wall faces meeting at 90 degrees
- Interior surfaces visible
- Must seamlessly connect with adjacent wall tiles

Background: Transparent (or solid magenta #FF00FF for easy removal)

Generate as a single cohesive sprite sheet where all tiles clearly belong together.`;

  if (verbose) {
    console.log('Generating tileset sheet...');
    console.log(`  Theme: ${theme}`);
    console.log(`  Sheet size: ${sheetWidth}x${sheetHeight}`);
  }

  try {
    const response = await ai.models.generateContent({
      model: IMAGE_GEN_MODEL,
      contents: [{ text: prompt }],
      generationConfig: {
        responseModalities: ['image', 'text']
      }
    });

    // Extract image from response
    for (const part of response.candidates?.[0]?.content?.parts || []) {
      if (part.inlineData?.mimeType?.startsWith('image/')) {
        const buffer = Buffer.from(part.inlineData.data, 'base64');
        if (verbose) {
          console.log('  Tileset sheet generated successfully');
        }
        return buffer;
      }
    }

    throw new Error('No image in response');
  } catch (error) {
    if (verbose) {
      console.log(`  Error: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Extract individual tiles from a tileset sheet
 *
 * @param {Buffer} sheetBuffer - PNG buffer of the tileset sheet
 * @param {Object} options - Extraction options
 * @returns {Promise<Object>} Map of tileName -> Buffer
 */
export async function extractTilesFromSheet(sheetBuffer, options = {}) {
  const {
    tileWidth = 64,
    tileHeight = 64,
    expectedTiles = 7,
    removeMagenta = true,
    verbose = false
  } = options;

  const sharp = (await import('sharp')).default;

  // Get sheet dimensions
  const metadata = await sharp(sheetBuffer).metadata();
  const origWidth = metadata.width;
  const origHeight = metadata.height;

  if (verbose) {
    console.log(`  Original sheet: ${origWidth}x${origHeight}`);
  }

  // Get raw pixel data to detect tile regions by wood color
  const { data, info } = await sharp(sheetBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;

  // Wood colors have R > G > B significantly (brown/orange tones)
  const isWood = (r, g, b) => r > 100 && r > g + 15 && g > b;

  // Find columns with wood content
  const contentCols = [];
  for (let x = 0; x < width; x++) {
    let hasContent = false;
    for (let y = 0; y < height && !hasContent; y++) {
      const idx = (y * width + x) * channels;
      if (isWood(data[idx], data[idx + 1], data[idx + 2])) {
        hasContent = true;
      }
    }
    if (hasContent) contentCols.push(x);
  }

  // Find continuous ranges
  const ranges = [];
  if (contentCols.length > 0) {
    let start = contentCols[0];
    let prev = contentCols[0];

    for (let i = 1; i < contentCols.length; i++) {
      if (contentCols[i] > prev + 20) {
        ranges.push({ start, end: prev });
        start = contentCols[i];
      }
      prev = contentCols[i];
    }
    ranges.push({ start, end: prev });
  }

  if (verbose) {
    console.log(`  Found ${ranges.length} tile regions`);
  }

  // Tile names to assign
  const tileNames = ['floor', 'wall_n', 'wall_w', 'corner_nw', 'corner_ne', 'corner_sw', 'corner_se'];
  const tiles = {};

  // Extract each detected region
  for (let i = 0; i < Math.min(ranges.length, tileNames.length); i++) {
    const range = ranges[i];
    const tileName = tileNames[i];

    // Find vertical bounds for this tile
    let minY = height, maxY = 0;
    for (let x = range.start; x <= range.end; x++) {
      for (let y = 0; y < height; y++) {
        const idx = (y * width + x) * channels;
        if (isWood(data[idx], data[idx + 1], data[idx + 2])) {
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }
      }
    }

    const extractX = range.start;
    const extractY = Math.max(0, minY - 5);
    const extractW = range.end - range.start + 1;
    const extractH = Math.min(maxY - minY + 10, height - extractY);

    if (verbose) {
      console.log(`  ${tileName}: x=${extractX}-${range.end}, y=${extractY}-${extractY + extractH}`);
    }

    // Extract tile region
    let tileBuffer = await sharp(sheetBuffer)
      .extract({
        left: extractX,
        top: extractY,
        width: extractW,
        height: extractH
      })
      .ensureAlpha()
      .png()
      .toBuffer();

    // Resize to target tile dimensions
    tileBuffer = await sharp(tileBuffer)
      .resize(tileWidth, tileHeight, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      })
      .png()
      .toBuffer();

    // Remove gray checkered background and make transparent
    const { data: tileData, info: tileInfo } = await sharp(tileBuffer)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { width: tw, height: th, channels: tc } = tileInfo;
    const cleanData = Buffer.alloc(tileData.length);

    for (let j = 0; j < tileData.length; j += tc) {
      const r = tileData[j];
      const g = tileData[j + 1];
      const b = tileData[j + 2];
      const a = tc === 4 ? tileData[j + 3] : 255;

      // Gray checkered background (two shades: ~147 and ~83)
      const isLightGray = Math.abs(r - 147) < 25 && Math.abs(g - 147) < 25 && Math.abs(b - 147) < 25;
      const isDarkGray = Math.abs(r - 83) < 25 && Math.abs(g - 83) < 25 && Math.abs(b - 83) < 25;
      // Magenta background
      const isMagenta = r > 200 && g < 100 && b > 200;

      if (isLightGray || isDarkGray || isMagenta) {
        cleanData[j] = 0;
        cleanData[j + 1] = 0;
        cleanData[j + 2] = 0;
        cleanData[j + 3] = 0;
      } else {
        cleanData[j] = r;
        cleanData[j + 1] = g;
        cleanData[j + 2] = b;
        cleanData[j + 3] = a;
      }
    }

    tileBuffer = await sharp(cleanData, { raw: { width: tw, height: th, channels: 4 } })
      .png()
      .toBuffer();

    tiles[tileName] = tileBuffer;
  }

  return tiles;
}

/**
 * Generate a room using the single-sheet approach for style consistency
 */
export async function generateRoomWithSheet(theme, options = {}) {
  const {
    outputDir = 'room/',
    apiKey = process.env.GEMINI_API_KEY,
    verbose = false
  } = options;

  const sharp = (await import('sharp')).default;

  if (verbose) {
    console.log(`\nGenerating room with unified tileset: ${theme}`);
    console.log(`  Output directory: ${outputDir}`);
  }

  // Ensure output directories exist
  await fsPromises.mkdir(outputDir, { recursive: true });
  await fsPromises.mkdir(path.join(outputDir, 'tiles'), { recursive: true });

  // Step 1: Generate tileset as single sheet
  if (verbose) console.log('\nStep 1: Generating tileset sheet...');
  const sheetBuffer = await generateTilesetSheet(theme, { apiKey, verbose });

  // Save the raw sheet for debugging
  await fsPromises.writeFile(path.join(outputDir, 'tileset-sheet.png'), sheetBuffer);

  // Step 2: Extract individual tiles
  if (verbose) console.log('\nStep 2: Extracting tiles from sheet...');
  const tiles = await extractTilesFromSheet(sheetBuffer, { verbose });

  // Step 3: Save individual tiles
  if (verbose) console.log('\nStep 3: Saving tiles...');
  for (const [name, buffer] of Object.entries(tiles)) {
    const tilePath = path.join(outputDir, 'tiles', `${name}.png`);
    await fsPromises.writeFile(tilePath, buffer);
    if (verbose) console.log(`  Saved: ${tilePath}`);
  }

  // Step 4: Get room layout
  const layout = getTemplate('office-small');

  // Step 5: Create atlas from tiles
  if (verbose) console.log('\nStep 4: Creating atlas...');
  const tileBuffers = Object.entries(tiles).map(([name, buffer]) => ({
    name,
    buffer
  }));

  const atlasInfo = await createAtlas(tileBuffers, {
    tileWidth: 64,
    tileHeight: 32,
    columns: 8,
    padding: 0
  });

  await fsPromises.writeFile(path.join(outputDir, 'atlas.png'), atlasInfo.buffer);

  // Step 6: Generate Tiled files
  if (verbose) console.log('\nStep 5: Generating Tiled files...');

  // Create layout atlas info for Tiled
  const layoutAtlasInfo = {
    ...atlasInfo,
    tilePositions: {}
  };

  // Map layout tile names to atlas positions
  const tileNameMapping = {
    'floor': 'floor',
    'wall-n': 'wall_n',
    'wall-w': 'wall_w',
    'corner-nw': 'corner_nw',
    'corner-ne': 'corner_ne',
    'corner-sw': 'corner_sw',
    'corner-se': 'corner_se'
  };

  for (const [layoutName, atlasName] of Object.entries(tileNameMapping)) {
    if (atlasInfo.tilePositions[atlasName]) {
      layoutAtlasInfo.tilePositions[layoutName] = atlasInfo.tilePositions[atlasName];
    }
  }

  const tiledMap = generateTiledMap(layout, layoutAtlasInfo, {
    tileWidth: 64,
    tileHeight: atlasInfo.tileHeight,
    tilesetSource: 'tileset.json'
  });

  const tilesetJSON = generateTilesetJSON(atlasInfo, {
    name: `${theme.replace(/\s+/g, '-')}-tileset`,
    imagePath: 'atlas.png'
  });

  await fsPromises.writeFile(
    path.join(outputDir, 'room.json'),
    JSON.stringify(tiledMap, null, 2)
  );

  await fsPromises.writeFile(
    path.join(outputDir, 'tileset.json'),
    JSON.stringify(tilesetJSON, null, 2)
  );

  // Save metadata
  const metadata = {
    theme,
    generatedAt: new Date().toISOString(),
    method: 'unified-sheet',
    tileCount: Object.keys(tiles).length,
    layout: layout.name
  };

  await fsPromises.writeFile(
    path.join(outputDir, 'metadata.json'),
    JSON.stringify(metadata, null, 2)
  );

  if (verbose) {
    console.log(`\nRoom generated successfully!`);
    console.log(`  Output: ${outputDir}`);
    console.log(`  Tiles: ${Object.keys(tiles).length}`);
  }

  // Convert tiles object to array format for CLI compatibility
  const tilesArray = Object.entries(tiles).map(([name, data]) => ({
    type: name,
    path: data.path,
    width: data.width,
    height: data.height
  }));

  return {
    outputDir,
    layout,
    tiles: tilesArray,  // Array format for CLI compatibility
    props: [],          // No props in sheet generation (yet)
    atlasPath: atlasInfo?.atlasPath,
    tiledMapPath: path.join(outputDir, 'room.json'),
    tilesetPath: path.join(outputDir, 'tileset.json'),
    metadataPath: path.join(outputDir, 'metadata.json'),
    atlasInfo,
    metadata
  };
}

/**
 * Isometric tile type configurations
 * Floors are 2:1 ratio (64x32), walls/corners have height (64x64)
 */
const TILE_TYPE_CONFIG = {
  'floor': {
    width: 64,
    height: 32,
    description: 'flat diamond-shaped ground tile'
  },
  // Directional walls - each faces INWARD toward room center
  'wall-n': {
    width: 64,
    height: 64,
    description: 'north wall - runs along top-right edge of room, faces south (inward)'
  },
  'wall-s': {
    width: 64,
    height: 64,
    description: 'south wall - runs along bottom-left edge of room, faces north (inward)'
  },
  'wall-e': {
    width: 64,
    height: 64,
    description: 'east wall - runs along bottom-right edge of room, faces west (inward)'
  },
  'wall-w': {
    width: 64,
    height: 64,
    description: 'west wall - runs along top-left edge of room, faces east (inward)'
  },
  // Legacy support
  'wall-left': { width: 64, height: 64, description: 'left-facing wall' },
  'wall-right': { width: 64, height: 64, description: 'right-facing wall' },
  // Corners
  'corner-nw': {
    width: 64,
    height: 64,
    description: 'northwest corner - top vertex of room, two walls meeting'
  },
  'corner-ne': {
    width: 64,
    height: 64,
    description: 'northeast corner - right vertex of room, two walls meeting'
  },
  'corner-sw': {
    width: 64,
    height: 64,
    description: 'southwest corner - left vertex of room, two walls meeting'
  },
  'corner-se': {
    width: 64,
    height: 64,
    description: 'southeast corner - bottom vertex of room, two walls meeting'
  }
};

/**
 * Get tile dimensions for a given type
 */
function getTileDimensions(tileType) {
  const config = TILE_TYPE_CONFIG[tileType] || TILE_TYPE_CONFIG['floor'];
  return { width: config.width, height: config.height };
}

/**
 * Calculate aspect ratio string from grid dimensions
 * The API accepts specific aspect ratios: 1:1, 3:2, 4:3, 16:9, 2:3, 3:4, 9:16
 * @param {number} cols - Number of columns
 * @param {number} rows - Number of rows
 * @returns {string} - Aspect ratio string for the API
 */
function calculateAspectRatio(cols, rows) {
  const ratio = cols / rows;
  if (ratio >= 1.7) return '16:9';
  if (ratio >= 1.4) return '3:2';
  if (ratio >= 1.2) return '4:3';
  if (ratio <= 0.6) return '9:16';
  if (ratio <= 0.75) return '2:3';
  if (ratio <= 0.85) return '3:4';
  return '1:1';
}

/**
 * Get MIME type based on file extension
 * @param {string} filePath - Path to the file
 * @returns {string} - MIME type string
 */
function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp'
  };
  return mimeTypes[ext] || 'image/png';
}

/**
 * Detect direction keywords from description
 * @param {string} description - Animation description
 * @returns {object} { direction: 'left'|'right'|'up'|'down'|null, isDirectional: boolean }
 */
function detectDirection(description) {
  const lower = description.toLowerCase();

  // Check for explicit directions
  if (lower.includes('left') || lower.includes('facing left')) {
    return { direction: 'left', isDirectional: true };
  }
  if (lower.includes('right') || lower.includes('facing right')) {
    return { direction: 'right', isDirectional: true };
  }
  if (lower.includes('up') || lower.includes('forward') || lower.includes('away')) {
    return { direction: 'up', isDirectional: true };
  }
  if (lower.includes('down') || lower.includes('toward') || lower.includes('front')) {
    return { direction: 'down', isDirectional: true };
  }

  return { direction: null, isDirectional: false };
}

/**
 * Get viewing angle instruction for a direction
 * @param {string} direction - Direction: 'left', 'right', 'up', or 'down'
 * @returns {string} Viewing angle instruction for the prompt
 */
function getViewingAngleInstruction(direction) {
  const instructions = {
    left: 'CHARACTER MUST FACE LEFT in EVERY frame. Show side profile view with character looking/moving toward the LEFT side of the image. The character should NEVER face forward or right.',
    right: 'CHARACTER MUST FACE RIGHT in EVERY frame. Show side profile view with character looking/moving toward the RIGHT side of the image. The character should NEVER face forward or left.',
    up: 'CHARACTER MUST FACE AWAY from camera in EVERY frame. Show back view with character looking/moving upward/away.',
    down: 'CHARACTER MUST FACE TOWARD camera in EVERY frame. Show front view with character looking/moving toward the viewer.'
  };
  return instructions[direction] || '';
}

/**
 * Generate a sprite sheet from a reference image
 *
 * Supports two call signatures for backward compatibility:
 * 1. New: generateSpriteSheet({ referenceImage, description, rows, cols, ... })
 * 2. Legacy: generateSpriteSheet(description, { frames, style, referenceImage, ... })
 *
 * @param {Object|string} optionsOrDescription - Options object or description string (legacy)
 * @param {Object} legacyOptions - Legacy options (only used if first arg is string)
 * @returns {Promise<Buffer>} - PNG buffer of generated sprite sheet
 */
export async function generateSpriteSheet(optionsOrDescription = {}, legacyOptions = {}) {
  // Handle legacy signature: generateSpriteSheet(description, options)
  let options;
  if (typeof optionsOrDescription === 'string') {
    const {
      frames = 8,
      style = 'pixel art',
      referenceImage = null,
      apiKey = process.env.GEMINI_API_KEY,
      verbose = false
    } = legacyOptions;

    // Calculate grid dimensions from frame count
    const cols = frames <= 4 ? 2 : (frames <= 6 ? 3 : 4);
    const rows = Math.ceil(frames / cols);

    options = {
      referenceImage,
      description: optionsOrDescription,
      rows,
      cols,
      style,
      apiKey,
      verbose
    };
  } else {
    options = optionsOrDescription;
  }

  const {
    referenceImage,
    projectReferences = [],  // Array of { buffer, mimeType, name } from project style references
    description = 'idle animation',
    rows = 2,
    cols = 3,
    style = 'isometric pixel art',
    apiKey = process.env.GEMINI_API_KEY,
    imageSize = '2K',
    verbose = false
  } = options;

  if (!apiKey) {
    throw new Error('GEMINI_API_KEY environment variable or apiKey option required');
  }

  // If no reference image, fall back to text-only generation (not recommended)
  if (!referenceImage) {
    if (verbose) {
      console.warn('  Warning: No reference image provided. Character consistency not guaranteed.');
    }
    return generateWithoutReference(description, {
      apiKey,
      rows,
      cols,
      style,
      imageSize,
      verbose
    });
  }

  // Load reference image with proper error handling
  let referenceBuffer;
  let referenceMimeType = 'image/png'; // default for buffers

  if (typeof referenceImage === 'string') {
    // It's a file path
    if (!fs.existsSync(referenceImage)) {
      throw new Error(`Reference image not found: ${referenceImage}`);
    }
    try {
      referenceBuffer = fs.readFileSync(referenceImage);
      referenceMimeType = getMimeType(referenceImage);
    } catch (err) {
      throw new Error(`Failed to read reference image "${referenceImage}": ${err.message}`);
    }
  } else if (Buffer.isBuffer(referenceImage)) {
    // It's already a buffer - assume PNG if no path available
    referenceBuffer = referenceImage;
  } else {
    throw new Error('referenceImage must be a file path string or Buffer');
  }

  const ai = new GoogleGenAI({ apiKey });
  const totalFrames = rows * cols;

  const aspectRatio = calculateAspectRatio(cols, rows);

  if (verbose) {
    console.log(`  Model: ${IMAGE_GEN_MODEL}`);
    console.log(`  Grid: ${cols}x${rows} (${totalFrames} frames)`);
    console.log(`  Aspect ratio: ${aspectRatio}`);
    console.log(`  Image size: ${imageSize}`);
    console.log(`  Style: ${style}`);
    console.log(`  Animation: ${description}`);
    console.log(`  Reference MIME type: ${referenceMimeType}`);
  }

  // Build the prompt using the template from TASK.md
  const prompt = buildSpriteSheetPrompt({
    description,
    rows,
    cols,
    style,
    totalFrames
  });

  if (verbose) {
    console.log(`  Generating sprite sheet...`);
  }

  try {
    // CRITICAL: Reference image comes FIRST in contents array
    // Build contents array: explicit reference first, then project references, then prompt
    const contents = [];

    // 1. Explicit reference image (highest priority)
    contents.push({
      inlineData: {
        mimeType: referenceMimeType,
        data: referenceBuffer.toString('base64')
      }
    });

    // 2. Project style references (injected automatically if in a project)
    for (const ref of projectReferences) {
      if (verbose) {
        console.log(`  Injecting project reference: ${ref.name}`);
      }
      contents.push({
        inlineData: {
          mimeType: ref.mimeType,
          data: ref.buffer.toString('base64')
        }
      });
    }

    // 3. Text prompt
    contents.push({ text: prompt });

    const response = await ai.models.generateContent({
      model: IMAGE_GEN_MODEL,
      contents: contents,
      config: {
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: {
          aspectRatio: aspectRatio,
          imageSize: imageSize
        }
      }
    });

    // Extract image from response
    const imageBuffer = extractImageFromResponse(response);

    if (!imageBuffer) {
      throw new Error('No image generated in response');
    }

    if (verbose) {
      console.log(`  Generated sprite sheet (${imageBuffer.length} bytes)`);
    }

    return imageBuffer;

  } catch (error) {
    if (error.message && error.message.includes('SAFETY')) {
      throw new Error('Content blocked by safety filters. Try a different description.');
    }
    throw error;
  }
}

/**
 * Generate multiple animations using multi-turn chat for consistency
 *
 * This maintains context between generations so the character stays consistent
 * across different animation sets (idle, walking, typing, etc.)
 *
 * @param {Object} options - Generation options
 * @param {string} options.referenceImage - Path to reference image (required)
 * @param {Array} options.animations - Array of animation definitions
 *   Each animation: { name: string, description: string, rows?: number, cols?: number }
 * @param {string} options.style - Art style (default: "isometric pixel art")
 * @param {string} options.apiKey - Gemini API key
 * @param {string} options.imageSize - Output image size: '1K', '2K', or '4K' (default: '2K')
 * @param {boolean} options.verbose - Enable verbose logging
 * @returns {Promise<Object>} - Object mapping animation name to sprite sheet Buffer
 */
export async function createAnimationSet(options = {}) {
  const {
    referenceImage,
    projectReferences = [],  // Array of { buffer, mimeType, name } from project style references
    animations = [],
    style = 'isometric pixel art',
    apiKey = process.env.GEMINI_API_KEY,
    imageSize = '2K',
    verbose = false
  } = options;

  if (!apiKey) {
    throw new Error('GEMINI_API_KEY environment variable or apiKey option required');
  }

  if (!referenceImage) {
    throw new Error('referenceImage is required for consistent character generation');
  }

  if (!animations || animations.length === 0) {
    throw new Error('At least one animation definition is required');
  }

  // Load reference image with proper error handling
  let referenceBuffer;
  let referenceMimeType = 'image/png'; // default for buffers

  if (typeof referenceImage === 'string') {
    if (!fs.existsSync(referenceImage)) {
      throw new Error(`Reference image not found: ${referenceImage}`);
    }
    try {
      referenceBuffer = fs.readFileSync(referenceImage);
      referenceMimeType = getMimeType(referenceImage);
    } catch (err) {
      throw new Error(`Failed to read reference image "${referenceImage}": ${err.message}`);
    }
  } else if (Buffer.isBuffer(referenceImage)) {
    // It's already a buffer - assume PNG if no path available
    referenceBuffer = referenceImage;
  } else {
    throw new Error('referenceImage must be a file path string or Buffer');
  }

  const ai = new GoogleGenAI({ apiKey });

  if (verbose) {
    console.log(`  Model: ${IMAGE_GEN_MODEL}`);
    console.log(`  Style: ${style}`);
    console.log(`  Image size: ${imageSize}`);
    console.log(`  Animations to generate: ${animations.length}`);
    console.log(`  Reference MIME type: ${referenceMimeType}`);
  }

  // Create a chat session for multi-turn context preservation
  // Note: imageConfig aspectRatio will be set per-animation based on grid dimensions
  const chat = ai.chats.create({
    model: IMAGE_GEN_MODEL,
    config: {
      responseModalities: ['TEXT', 'IMAGE']
    }
  });

  const results = {};

  // First message establishes the character reference
  const referenceMessage = [
    {
      inlineData: {
        mimeType: referenceMimeType,
        data: referenceBuffer.toString('base64')
      }
    }
  ];

  // Inject project style references
  for (const ref of projectReferences) {
    if (verbose) {
      console.log(`  Injecting project reference: ${ref.name}`);
    }
    referenceMessage.push({
      inlineData: {
        mimeType: ref.mimeType,
        data: ref.buffer.toString('base64')
      }
    });
  }

  // Add the text instruction
  referenceMessage.push({
    text: `This is a character reference image. I will be asking you to generate sprite sheet animations of THIS EXACT CHARACTER in ${style} style.

Please study this character's:
- Color palette
- Proportions
- Distinctive features
- Overall design

You must maintain perfect consistency with this reference for all animations I request.`
  });

  if (verbose) {
    console.log(`  Establishing character reference...`);
  }

  try {
    // Send the reference image first to establish context
    await chat.sendMessage({ message: referenceMessage });

    // Generate each animation in sequence (maintaining chat context)
    for (const anim of animations) {
      const {
        name,
        description,
        rows = 2,
        cols = 3
      } = anim;

      const totalFrames = rows * cols;
      const aspectRatio = calculateAspectRatio(cols, rows);

      if (verbose) {
        console.log(`  Generating "${name}" (${cols}x${rows}, ${aspectRatio})...`);
      }

      const prompt = buildSpriteSheetPrompt({
        description,
        rows,
        cols,
        style,
        totalFrames
      });

      // Send message with reference image again for reinforcement
      // Include imageConfig for each animation based on its grid dimensions
      const response = await chat.sendMessage({
        message: [
          {
            inlineData: {
              mimeType: referenceMimeType,
              data: referenceBuffer.toString('base64')
            }
          },
          { text: prompt }
        ],
        config: {
          imageConfig: {
            aspectRatio: aspectRatio,
            imageSize: imageSize
          }
        }
      });

      const imageBuffer = extractImageFromResponse(response);

      if (imageBuffer) {
        results[name] = imageBuffer;
        if (verbose) {
          console.log(`    Generated (${imageBuffer.length} bytes)`);
        }
      } else {
        console.warn(`    Warning: No image generated for "${name}"`);
        results[name] = null;
      }
    }

    return results;

  } catch (error) {
    if (error.message && error.message.includes('SAFETY')) {
      throw new Error('Content blocked by safety filters. Try different descriptions.');
    }
    throw error;
  }
}

/**
 * Build a sprite sheet generation prompt
 * Uses the template from TASK.md for consistent results
 */
function buildSpriteSheetPrompt(options) {
  const {
    description,
    rows,
    cols,
    style,
    totalFrames
  } = options;

  // Detect direction from description
  const { direction, isDirectional } = detectDirection(description);

  // Generate frame descriptions with direction awareness
  const frameDescriptions = generateFrameDescriptions(description, totalFrames, direction);

  // Build viewing angle requirement if directional
  const viewingAngleReq = isDirectional
    ? `\n7. VIEWING ANGLE: ${getViewingAngleInstruction(direction)}`
    : '';

  return `Using the provided character reference, generate a ${cols}x${rows} sprite sheet grid.

CRITICAL REQUIREMENTS:
1. EXACT same character design in every frame - match the reference image precisely
2. Grid layout: ${cols} columns x ${rows} rows
3. Each cell is the same size
4. Character anchored at bottom-center of each cell
5. White or transparent background
6. Style: ${style}${viewingAngleReq}

ANIMATION SEQUENCE (left-to-right, top-to-bottom):
${frameDescriptions}

The final frame should smoothly loop back to frame 1.
${isDirectional ? `\nIMPORTANT: Maintain ${direction.toUpperCase()}-facing direction in ALL frames. Do not rotate or flip the character.` : ''}
DO NOT change the character design. Every frame must look like the same character from the reference image.`;
}

/**
 * Generate frame-by-frame pose descriptions for common animations
 * @param {string} description - Animation description
 * @param {number} totalFrames - Total number of frames
 * @param {string|null} direction - Direction: 'left', 'right', 'up', 'down', or null
 */
function generateFrameDescriptions(description, totalFrames, direction = null) {
  const lowerDesc = description.toLowerCase();

  // Direction prefix for frame descriptions
  const dirPrefix = direction ? `Side profile facing ${direction.toUpperCase()}, ` : '';

  // Direction-aware animation presets
  const animationPresets = {
    idle: [
      'Neutral standing pose',
      'Slight breathing motion - chest slightly expanded',
      'Neutral standing pose',
      'Slight breathing motion - chest slightly contracted',
      'Blink - eyes closed',
      'Neutral standing pose'
    ],
    walk: [
      `${dirPrefix}contact pose - front foot heel down, back foot toe down`,
      `${dirPrefix}passing pose - legs passing each other`,
      `${dirPrefix}contact pose - opposite foot forward`,
      `${dirPrefix}passing pose - legs passing each other`
    ],
    walking: [
      `${dirPrefix}contact pose - front foot heel down, back foot toe down`,
      `${dirPrefix}passing pose - legs passing each other`,
      `${dirPrefix}contact pose - opposite foot forward`,
      `${dirPrefix}passing pose - legs passing each other`
    ],
    typing: [
      'Both hands on keyboard, neutral',
      'Left hand raised slightly',
      'Left hand pressing key',
      'Both hands neutral',
      'Right hand raised slightly',
      'Right hand pressing key'
    ],
    thinking: [
      'Hand on chin, looking up',
      'Hand on chin, eyes looking left',
      'Hand on chin, eyes looking up',
      'Hand on chin, eyes looking right'
    ],
    jump: [
      `${dirPrefix}crouching, preparing to jump`,
      `${dirPrefix}pushing off, legs extending`,
      `${dirPrefix}mid-air, body stretched upward`,
      `${dirPrefix}peak of jump, fully extended`,
      `${dirPrefix}starting to descend`,
      `${dirPrefix}landing, knees bending`
    ],
    run: [
      `${dirPrefix}push off - back leg extended, front leg lifting`,
      `${dirPrefix}flight - both feet off ground, legs tucked`,
      `${dirPrefix}landing - front leg reaching, back leg tucked`,
      `${dirPrefix}flight - both feet off ground, legs switching`
    ],
    wave: [
      'Arm at side',
      'Arm raising',
      'Arm up, hand open',
      'Hand tilting left',
      'Hand tilting right',
      'Arm lowering'
    ],
    alert: [
      'Normal pose',
      'Eyes wide, ears perked',
      'Slight jump, surprised',
      'Eyes wide, ears perked'
    ]
  };

  // Find matching preset
  let poses = null;
  for (const [key, preset] of Object.entries(animationPresets)) {
    if (lowerDesc.includes(key)) {
      poses = preset;
      break;
    }
  }

  // If no preset found, generate generic frame descriptions
  if (!poses) {
    poses = [];
    for (let i = 0; i < totalFrames; i++) {
      if (i === 0) {
        poses.push(`${dirPrefix}Starting pose for ${description}`);
      } else if (i === totalFrames - 1) {
        poses.push(`${dirPrefix}End pose (loops to frame 1)`);
      } else {
        poses.push(`${dirPrefix}Animation frame ${i + 1} - progressive motion`);
      }
    }
  }

  // Extend or trim poses to match totalFrames
  while (poses.length < totalFrames) {
    // Duplicate poses to fill
    poses = [...poses, ...poses];
  }
  poses = poses.slice(0, totalFrames);

  // Format as numbered list
  return poses.map((pose, i) => `- Frame ${i + 1}: ${pose}`).join('\n');
}

/**
 * Extract image buffer from Gemini API response
 */
function extractImageFromResponse(response) {
  if (!response) return null;

  // Handle different response structures
  let candidates = response.candidates;

  // If response has a different structure (e.g., from chat)
  if (!candidates && response.response && response.response.candidates) {
    candidates = response.response.candidates;
  }

  if (!candidates || !candidates[0]) {
    return null;
  }

  const parts = candidates[0].content?.parts || [];

  for (const part of parts) {
    if (part.inlineData) {
      return Buffer.from(part.inlineData.data, 'base64');
    }
  }

  return null;
}

/**
 * Fallback generation without reference image
 * Used when no reference is available (not recommended for character consistency)
 */
async function generateWithoutReference(description, options) {
  const {
    apiKey,
    rows,
    cols,
    style,
    imageSize = '2K',
    verbose
  } = options;

  const ai = new GoogleGenAI({ apiKey });
  const totalFrames = rows * cols;
  const aspectRatio = calculateAspectRatio(cols, rows);

  // Detect direction from description
  const { direction, isDirectional } = detectDirection(description);

  // Build viewing angle requirement if directional
  const viewingAngleReq = isDirectional
    ? `\n8. VIEWING ANGLE: ${getViewingAngleInstruction(direction)}`
    : '';

  // Generate frame descriptions with direction awareness
  const frameDescriptions = generateFrameDescriptions(description, totalFrames, direction);

  const prompt = `Generate a ${cols}x${rows} sprite sheet grid (${cols} columns, ${rows} rows) for animation.

SUBJECT: ${description}
STYLE: ${style}
TOTAL FRAMES: ${totalFrames}

CRITICAL REQUIREMENTS:
1. GRID STRUCTURE: Exactly ${cols} columns and ${rows} rows of equal-sized cells
2. CONSISTENT SIZE: The character must be the EXACT SAME SIZE in every frame
3. CONSISTENT POSITION: Character's feet/base anchored at the SAME POSITION (bottom-center) in each cell
4. SEQUENTIAL ANIMATION: Frames read left-to-right, top-to-bottom showing smooth motion progression
5. IDENTICAL CHARACTER: Same exact character design, colors, proportions in all frames
6. CELL BOUNDARIES: Each frame must stay WITHIN its grid cell - no overlapping between cells
7. BACKGROUND: White or transparent background${viewingAngleReq}

ANIMATION SEQUENCE (left-to-right, top-to-bottom):
${frameDescriptions}

The final frame should smoothly loop back to frame 1.
${isDirectional ? `\nIMPORTANT: Maintain ${direction.toUpperCase()}-facing direction in ALL frames. Do not rotate or flip the character.` : ''}
DO NOT: Change character size, position, or design between frames.`;

  if (verbose) {
    console.log(`  Generating ${totalFrames}-frame sprite sheet (no reference)...`);
    console.log(`  Aspect ratio: ${aspectRatio}, Image size: ${imageSize}`);
  }

  const response = await ai.models.generateContent({
    model: IMAGE_GEN_MODEL,
    contents: prompt,
    config: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: {
        aspectRatio: aspectRatio,
        imageSize: imageSize
      }
    }
  });

  return extractImageFromResponse(response);
}

// Legacy exports for backward compatibility with index.js
// generateFrames and combineFramesToSheet are aliased to generateSpriteSheet
// since the new implementation handles the legacy signature

/**
 * @deprecated Use generateSpriteSheet instead
 */
export async function generateFrames(description, options = {}) {
  // generateFrames was used for frame-by-frame generation which didn't work well
  // Now it just delegates to generateSpriteSheet for sprite sheet generation
  return generateSpriteSheet(description, options);
}

/**
 * @deprecated This function was used to combine separately generated frames
 * Now generateSpriteSheet generates complete sprite sheets directly
 */
export async function combineFramesToSheet(frameBuffers, options = {}) {
  // This function is kept for API compatibility but shouldn't be needed
  // The new workflow generates complete sprite sheets, not individual frames
  throw new Error('combineFramesToSheet is deprecated. Use generateSpriteSheet to generate complete sprite sheets.');
}

/**
 * Build prompt for tile generation
 * @param {string} description - Tile description
 * @param {Object} options - Tile options
 * @returns {string} Prompt for AI
 */
function buildTilePrompt(description, options) {
  const { type = 'floor', tileSize, seamless = true, style = 'isometric pixel art' } = options;

  // Get correct dimensions for this tile type
  const dims = getTileDimensions(type);
  const width = dims.width;
  const height = dims.height;

  let prompt = `Generate a game-ready ISOMETRIC TILE:

TILE TYPE: ${type}
THEME: ${description}
EXACT DIMENSIONS: ${width}x${height} pixels
STYLE: ${style}

ISOMETRIC GEOMETRY RULES (CRITICAL):
- Use 2:1 pixel ratio for all isometric lines (2 pixels horizontal for every 1 pixel vertical)
- This creates the standard ~26.57 degree isometric angle
- All edges must follow this 2:1 slope precisely

`;

  if (type === 'floor') {
    prompt += `FLOOR TILE REQUIREMENTS:
- Diamond/rhombus shape filling the ${width}x${height} canvas
- Viewed from ABOVE at isometric angle
- The diamond points touch the center of each edge of the tile
- FLAT horizontal surface - NO vertical elements
- Texture should tile seamlessly in all directions
- Lighting from top-left corner

SHAPE REFERENCE:
- Top point at center-top of image
- Bottom point at center-bottom
- Left point at center-left
- Right point at center-right
- Fill the entire diamond with the floor texture

`;
  } else if (type === 'wall-left' || type === 'wall-right') {
    const facing = type === 'wall-left' ? 'LEFT (facing viewer\'s left)' : 'RIGHT (facing viewer\'s right)';
    const receding = type === 'wall-left' ? 'recedes toward the right' : 'recedes toward the left';

    prompt += `WALL TILE REQUIREMENTS:
- VERTICAL wall surface that ${receding}
- Wall faces ${facing}
- Height: The wall should have visible vertical height (this is a ${width}x${height} tile)
- Base: Bottom of wall aligns with where floor tiles would connect
- The wall shows a VERTICAL FACE, not a horizontal surface

STRUCTURE:
- Top edge: Horizontal wall top following 2:1 isometric slope
- Front face: The main visible vertical surface with texture
- Bottom edge: Where wall meets floor level
- The wall should look like you're viewing it from below and to the side

`;
  } else if (type.startsWith('corner-')) {
    const position = type.replace('corner-', '').toUpperCase();
    prompt += `CORNER TILE REQUIREMENTS:
- Two wall surfaces meeting at 90 degree angle
- Position: ${position} corner (${position === 'NW' ? 'northwest' : position === 'NE' ? 'northeast' : position === 'SW' ? 'southwest' : 'southeast'})
- Both wall faces visible, meeting at the corner
- Height matches wall tiles (${height}px tall)
- Must seamlessly connect to adjacent wall-left and wall-right tiles

STRUCTURE for ${position} corner:
${position === 'NW' ? '- Left face visible (facing left)\n- Back face visible (facing away)\n- Corner vertex points toward viewer' : ''}
${position === 'NE' ? '- Right face visible (facing right)\n- Back face visible (facing away)\n- Corner vertex points toward viewer' : ''}
${position === 'SW' ? '- Left face visible (facing left)\n- Front face visible (facing toward viewer)\n- Corner vertex points away from viewer' : ''}
${position === 'SE' ? '- Right face visible (facing right)\n- Front face visible (facing toward viewer)\n- Corner vertex points away from viewer' : ''}

`;
  }

  prompt += `OUTPUT REQUIREMENTS:
1. EXACT ${width}x${height} pixel dimensions
2. Transparent background (PNG with alpha channel)
3. Tile content fills the canvas appropriately for its type
4. Consistent ${style} aesthetic
5. Lighting from top-left
6. Clean pixel edges, no anti-aliasing artifacts
7. Ready for game engine use

Generate ONLY the tile image, ${width}x${height} pixels, transparent background.`;

  return prompt;
}

/**
 * Build a static asset generation prompt
 * Unlike sprite sheets, this generates a single image with no grid layout
 * @param {string} description - What to generate
 * @param {string} style - Art style
 * @returns {string} - The prompt for static asset generation
 */
function buildStaticAssetPrompt(description, style) {
  return `Generate a SINGLE STATIC ${style} asset:

SUBJECT: ${description}

CRITICAL REQUIREMENTS:
1. ONE image only - NOT a sprite sheet, NOT multiple frames, NOT a grid
2. Transparent background (alpha channel)
3. Consistent with any reference images provided
4. Clean edges appropriate for the art style
5. Centered composition with even padding on all sides

COMPOSITION:
- Asset should fill 70-80% of the frame
- Even padding on all sides
- Consistent lighting from top-left

OUTPUT FORMAT:
- Single PNG image
- Transparent background
- The asset centered in frame`;
}

/**
 * Generate a single static asset image (not animated)
 *
 * This function generates a single static image rather than an animated sprite sheet.
 * Useful for generating game objects, props, UI elements, backgrounds, etc.
 *
 * @param {string} description - What to generate (e.g., "wooden desk with computer")
 * @param {Object} options - Generation options
 * @param {string} options.referenceImage - Path to reference image for style consistency
 * @param {string} options.style - Art style (default: "isometric pixel art")
 * @param {string} options.outputPath - Where to save result (default: "static-asset.png")
 * @param {string} options.apiKey - Gemini API key (default: GEMINI_API_KEY env var)
 * @param {string} options.imageSize - Output image size: '1K', '2K', or '4K' (default: '2K')
 * @param {boolean} options.verbose - Enable verbose logging
 * @returns {Promise<string>} - Path to generated image
 */
export async function generateStaticAsset(description, options = {}) {
  const {
    referenceImage = null,
    projectReferences = [],  // Array of { buffer, mimeType, name } from project style references
    style = 'isometric pixel art',
    outputPath = 'static-asset.png',
    apiKey = process.env.GEMINI_API_KEY,
    imageSize = '2K',
    verbose = false
  } = options;

  if (!apiKey) {
    throw new Error('GEMINI_API_KEY environment variable or apiKey option required');
  }

  if (!description) {
    throw new Error('description is required for static asset generation');
  }

  const ai = new GoogleGenAI({ apiKey });

  if (verbose) {
    console.log(`  Model: ${IMAGE_GEN_MODEL}`);
    console.log(`  Image size: ${imageSize}`);
    console.log(`  Style: ${style}`);
    console.log(`  Description: ${description}`);
    console.log(`  Output path: ${outputPath}`);
  }

  // Build the prompt for static asset generation
  const prompt = buildStaticAssetPrompt(description, style);

  // Prepare contents array - reference image first (if provided), then prompt
  const contents = [];

  // Load and add reference image if provided
  if (referenceImage) {
    let referenceBuffer;
    let referenceMimeType = 'image/png';

    if (typeof referenceImage === 'string') {
      // It's a file path
      if (!fs.existsSync(referenceImage)) {
        throw new Error(`Reference image not found: ${referenceImage}`);
      }
      try {
        referenceBuffer = fs.readFileSync(referenceImage);
        referenceMimeType = getMimeType(referenceImage);
      } catch (err) {
        throw new Error(`Failed to read reference image "${referenceImage}": ${err.message}`);
      }
    } else if (Buffer.isBuffer(referenceImage)) {
      // It's already a buffer - assume PNG if no path available
      referenceBuffer = referenceImage;
    } else {
      throw new Error('referenceImage must be a file path string or Buffer');
    }

    if (verbose) {
      console.log(`  Reference image: ${typeof referenceImage === 'string' ? referenceImage : '(buffer)'}`);
      console.log(`  Reference MIME type: ${referenceMimeType}`);
    }

    // CRITICAL: Reference image comes FIRST in contents array
    contents.push({
      inlineData: {
        mimeType: referenceMimeType,
        data: referenceBuffer.toString('base64')
      }
    });
  }

  // Inject project style references (after explicit reference, before prompt)
  for (const ref of projectReferences) {
    if (verbose) {
      console.log(`  Injecting project reference: ${ref.name}`);
    }
    contents.push({
      inlineData: {
        mimeType: ref.mimeType,
        data: ref.buffer.toString('base64')
      }
    });
  }

  // Add the text prompt
  contents.push({ text: prompt });

  if (verbose) {
    console.log(`  Generating static asset...`);
  }

  try {
    const response = await ai.models.generateContent({
      model: IMAGE_GEN_MODEL,
      contents: contents,
      config: {
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: {
          aspectRatio: '1:1',  // Square format works best for single centered assets
          imageSize: imageSize
        }
      }
    });

    // Extract image from response
    const imageBuffer = extractImageFromResponse(response);

    if (!imageBuffer) {
      throw new Error('No image generated in response');
    }

    if (verbose) {
      console.log(`  Generated static asset (${imageBuffer.length} bytes)`);
    }

    // Ensure output directory exists
    const outputDir = path.dirname(outputPath);
    if (outputDir && outputDir !== '.' && !fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Save the image
    fs.writeFileSync(outputPath, imageBuffer);

    if (verbose) {
      console.log(`  Saved to: ${outputPath}`);
    }

    return outputPath;

  } catch (error) {
    if (error.message && error.message.includes('SAFETY')) {
      throw new Error('Content blocked by safety filters. Try a different description.');
    }
    throw error;
  }
}

/**
 * Generate a seamless environment tile
 * @param {string} description - Tile description (e.g., "grass floor", "stone bricks")
 * @param {Object} options - Generation options
 * @param {string} options.type - Tile type: floor, wall-left, wall-right, corner-nw, etc.
 * @param {string} options.tileSize - Tile dimensions "WxH" (default: "64x32")
 * @param {string} options.style - Art style (default: "isometric pixel art")
 * @param {boolean} options.seamless - Ensure seamless edges (default: true)
 * @param {string|Buffer} options.referenceImage - Optional reference for style consistency
 * @param {Array} options.projectReferences - Project style references for auto-injection
 * @param {string} options.outputPath - Output file path (default: "tile.png")
 * @param {string} options.apiKey - Gemini API key
 * @param {boolean} options.verbose - Enable verbose logging
 * @returns {Promise<string>} Path to generated tile
 */
export async function generateTile(description, options = {}) {
  const {
    type = 'floor',
    tileSize = '64x32',
    style = 'isometric pixel art',
    seamless = true,
    referenceImage,
    projectReferences = [],
    outputPath = 'tile.png',
    apiKey = process.env.GEMINI_API_KEY,
    verbose = false
  } = options;

  if (!apiKey) {
    throw new Error('GEMINI_API_KEY environment variable is required');
  }

  if (verbose) {
    console.log(`Generating ${type} tile: ${description}`);
    console.log(`  Size: ${tileSize}, Style: ${style}, Seamless: ${seamless}`);
  }

  const ai = new GoogleGenAI({ apiKey });

  // Build contents array
  const contents = [];

  // Add explicit reference image first (highest priority)
  if (referenceImage) {
    let imageBuffer;
    let mimeType;

    if (Buffer.isBuffer(referenceImage)) {
      imageBuffer = referenceImage;
      mimeType = 'image/png';
    } else {
      imageBuffer = await fsPromises.readFile(referenceImage);
      mimeType = getMimeType(referenceImage);
    }

    if (verbose) {
      console.log(`  Using reference image: ${typeof referenceImage === 'string' ? referenceImage : 'Buffer'}`);
    }

    contents.push({
      inlineData: {
        mimeType,
        data: imageBuffer.toString('base64')
      }
    });
  }

  // Add project style references
  for (const ref of projectReferences) {
    if (verbose) {
      console.log(`  Injecting project reference: ${ref.name}`);
    }
    contents.push({
      inlineData: {
        mimeType: ref.mimeType,
        data: ref.buffer.toString('base64')
      }
    });
  }

  // Build and add the prompt
  const prompt = buildTilePrompt(description, { type, tileSize, seamless, style });
  contents.push({ text: prompt });

  if (verbose) {
    console.log('  Calling Gemini API...');
  }

  // Call Gemini API
  const result = await ai.models.generateContent({
    model: IMAGE_GEN_MODEL,
    contents: [{ role: 'user', parts: contents }],
    generationConfig: {
      responseModalities: ['image', 'text'],
      responseMimeType: 'image/png'
    }
  });

  // Extract image from response
  const response = result.response;
  if (!response || !response.candidates || response.candidates.length === 0) {
    throw new Error('No response from Gemini API');
  }

  const candidate = response.candidates[0];
  if (!candidate.content || !candidate.content.parts) {
    throw new Error('Invalid response structure from Gemini API');
  }

  const imagePart = candidate.content.parts.find(
    part => part.inlineData && part.inlineData.mimeType && part.inlineData.mimeType.startsWith('image/')
  );

  if (!imagePart) {
    // Check for safety filter
    if (candidate.finishReason === 'SAFETY') {
      throw new Error('Image generation blocked by safety filter. Try a different description.');
    }
    throw new Error('No image in response from Gemini API');
  }

  // Extract raw buffer from AI response
  const rawBuffer = Buffer.from(imagePart.inlineData.data, 'base64');

  // Get correct dimensions for this tile type (walls are taller than floors)
  const dims = getTileDimensions(type);

  // Post-process: crop to content and resize to exact dimensions
  if (verbose) {
    console.log(`  Post-processing tile to exact dimensions (${dims.width}x${dims.height})...`);
  }

  const imageBuffer = await processTileImage(rawBuffer, {
    targetWidth: dims.width,
    targetHeight: dims.height,
    cropToContent: true,
    verbose
  });

  // Ensure output directory exists
  const outputDir = path.dirname(outputPath);
  if (outputDir && outputDir !== '.') {
    await fsPromises.mkdir(outputDir, { recursive: true });
  }

  await fsPromises.writeFile(outputPath, imageBuffer);

  if (verbose) {
    console.log(`  Saved tile to: ${outputPath}`);
  }

  return outputPath;
}

/**
 * Generate a coordinated tileset with consistent style
 * @param {string} theme - Tileset theme (e.g., "stone dungeon", "grassy meadow")
 * @param {Object} options - Generation options
 * @param {string[]} options.include - Tile types to include (default: ['floor', 'walls', 'corners'])
 * @param {string} options.tileSize - Tile dimensions "WxH" (default: "64x32")
 * @param {string} options.style - Art style (default: "isometric pixel art")
 * @param {string|Buffer} options.referenceImage - Optional reference for style
 * @param {Array} options.projectReferences - Project style references
 * @param {string} options.outputDir - Output directory (default: "tileset/")
 * @param {string} options.apiKey - Gemini API key
 * @param {boolean} options.verbose - Enable verbose logging
 * @returns {Promise<Object>} Object with generated tile paths and metadata
 */
export async function generateTileset(theme, options = {}) {
  const {
    include = ['floor', 'walls', 'corners'],
    tileSize = '64x32',
    style = 'isometric pixel art',
    referenceImage,
    projectReferences = [],
    outputDir = 'tileset/',
    apiKey = process.env.GEMINI_API_KEY,
    verbose = false
  } = options;

  if (!apiKey) {
    throw new Error('GEMINI_API_KEY environment variable is required');
  }

  // Expand shorthand includes to full tile types
  const tilesToGenerate = expandTileTypes(include);

  if (verbose) {
    console.log(`Generating tileset: ${theme}`);
    console.log(`  Style: ${style}`);
    console.log(`  Size: ${tileSize}`);
    console.log(`  Tiles to generate: ${tilesToGenerate.join(', ')}`);
  }

  // Ensure output directory exists
  await fsPromises.mkdir(outputDir, { recursive: true });

  const ai = new GoogleGenAI({ apiKey });

  // Create chat session for style consistency
  const chat = ai.chats.create({
    model: IMAGE_GEN_MODEL,
    config: {
      responseModalities: ['text', 'image']
    }
  });

  // Build initial context with any reference images
  const initialParts = [];

  // Add reference image if provided
  if (referenceImage) {
    let imageBuffer;
    let mimeType;

    if (Buffer.isBuffer(referenceImage)) {
      imageBuffer = referenceImage;
      mimeType = 'image/png';
    } else {
      imageBuffer = await fsPromises.readFile(referenceImage);
      mimeType = getMimeType(referenceImage);
    }

    initialParts.push({
      inlineData: {
        mimeType,
        data: imageBuffer.toString('base64')
      }
    });
  }

  // Add project references
  for (const ref of projectReferences) {
    if (verbose) {
      console.log(`  Injecting project reference: ${ref.name}`);
    }
    initialParts.push({
      inlineData: {
        mimeType: ref.mimeType,
        data: ref.buffer.toString('base64')
      }
    });
  }

  // Establish theme and style in first message
  initialParts.push({
    text: `I'm creating a "${theme}" tileset for an isometric game.

STYLE: ${style}
TILE SIZE: ${tileSize} pixels

Please establish and maintain these consistent elements across ALL tiles:
1. A cohesive color palette (3-5 main colors that fit the "${theme}" theme)
2. Consistent lighting direction (top-left light source)
3. Consistent level of detail and texture style
4. True isometric perspective (2:1 width-to-height ratio for floors)

I will request multiple tiles. Each must seamlessly match the others in style.

Confirm you understand and briefly describe the color palette you'll use for "${theme}".`
  });

  if (verbose) {
    console.log('  Establishing theme with AI...');
  }

  // Send initial message to establish theme
  const themeResponse = await chat.sendMessage({ message: initialParts });

  if (verbose && themeResponse.text) {
    console.log(`  Theme established: ${themeResponse.text.substring(0, 100)}...`);
  }

  // Generate each tile
  const generatedTiles = [];
  const [width, height] = tileSize.split('x').map(Number);

  for (let i = 0; i < tilesToGenerate.length; i++) {
    const tileType = tilesToGenerate[i];
    const tileName = `${tileType.replace(/-/g, '_')}`;
    const outputPath = path.join(outputDir, `${tileName}.png`);

    if (verbose) {
      console.log(`  Generating ${i + 1}/${tilesToGenerate.length}: ${tileType}...`);
    }

    // Build tile-specific prompt
    const tilePrompt = buildTilePromptForTileset(theme, tileType, tileSize, style);

    try {
      // Generate tile through chat (maintains context)
      const tileResponse = await chat.sendMessage({
        message: tilePrompt
      });

      // Extract image from response
      let imageBuffer = null;

      if (tileResponse.candidates && tileResponse.candidates[0]) {
        const parts = tileResponse.candidates[0].content?.parts || [];
        const imagePart = parts.find(p => p.inlineData?.mimeType?.startsWith('image/'));
        if (imagePart) {
          imageBuffer = Buffer.from(imagePart.inlineData.data, 'base64');
        }
      }

      // Alternative: check response directly
      if (!imageBuffer && tileResponse.response?.candidates) {
        const parts = tileResponse.response.candidates[0]?.content?.parts || [];
        const imagePart = parts.find(p => p.inlineData?.mimeType?.startsWith('image/'));
        if (imagePart) {
          imageBuffer = Buffer.from(imagePart.inlineData.data, 'base64');
        }
      }

      if (!imageBuffer) {
        console.warn(`  Warning: No image generated for ${tileType}`);
        continue;
      }

      // Get correct dimensions for this specific tile type
      const dims = getTileDimensions(tileType);
      const targetWidth = dims.width;
      const targetHeight = dims.height;

      // Post-process: crop to content and resize to exact dimensions
      const processedBuffer = await processTileImage(imageBuffer, {
        targetWidth,
        targetHeight,
        cropToContent: true,
        verbose
      });

      // Save processed tile
      await fsPromises.writeFile(outputPath, processedBuffer);

      generatedTiles.push({
        name: tileName,
        type: tileType,
        file: `${tileName}.png`,
        path: outputPath
      });

      if (verbose) {
        console.log(`    Saved: ${outputPath}`);
      }

    } catch (error) {
      console.warn(`  Warning: Failed to generate ${tileType}: ${error.message}`);
    }
  }

  // Generate metadata
  const metadata = {
    name: theme.toLowerCase().replace(/\s+/g, '-'),
    theme,
    style,
    tileSize: { width, height },
    generated: new Date().toISOString(),
    tiles: generatedTiles.map(t => ({
      name: t.name,
      type: t.type,
      file: t.file
    }))
  };

  const metadataPath = path.join(outputDir, 'metadata.json');
  await fsPromises.writeFile(metadataPath, JSON.stringify(metadata, null, 2));

  if (verbose) {
    console.log(`  Metadata saved: ${metadataPath}`);
    console.log(`  Generated ${generatedTiles.length}/${tilesToGenerate.length} tiles`);
  }

  return {
    outputDir,
    metadata,
    tiles: generatedTiles
  };
}

/**
 * Expand shorthand tile type names to full list
 */
function expandTileTypes(include) {
  const expanded = [];

  for (const type of include) {
    switch (type.toLowerCase()) {
      case 'floor':
        expanded.push('floor');
        break;
      case 'walls':
        // Generate all 4 directional walls for proper room enclosure
        expanded.push('wall-n', 'wall-s', 'wall-e', 'wall-w');
        break;
      case 'corners':
        expanded.push('corner-nw', 'corner-ne', 'corner-sw', 'corner-se');
        break;
      default:
        // Allow specific types like 'wall-n', 'corner-nw'
        expanded.push(type);
    }
  }

  return expanded;
}

/**
 * Build prompt for a specific tile in a tileset (maintains context)
 */
function buildTilePromptForTileset(theme, tileType, tileSize, style) {
  // Get correct dimensions for this tile type
  const dims = getTileDimensions(tileType);
  const width = dims.width;
  const height = dims.height;

  let prompt = `Generate the ${tileType.toUpperCase()} tile for the "${theme}" tileset.

EXACT DIMENSIONS: ${width}x${height} pixels
STYLE: ${style}

CRITICAL ISOMETRIC RULES:
- All isometric lines use 2:1 pixel ratio (2 horizontal : 1 vertical)
- This creates the standard 26.57 degree isometric angle
- Light source from top-left, shadows to bottom-right
- Clean pixel edges, no anti-aliasing blur

`;

  if (tileType === 'floor') {
    prompt += `FLOOR TILE REQUIREMENTS:
- Perfect diamond/rhombus shape viewed from ABOVE
- The diamond points touch the exact CENTER of each edge:
  * Top point at (${width/2}, 0)
  * Right point at (${width}, ${height/2})
  * Bottom point at (${width/2}, ${height})
  * Left point at (0, ${height/2})
- FLAT horizontal surface - NO vertical walls or height
- Fill the entire diamond with floor texture (wood/stone/etc)
- Edges must tile SEAMLESSLY with adjacent floor tiles

`;
  } else if (tileType === 'wall-n' || tileType === 'wall_n') {
    prompt += `NORTH WALL TILE - INTERIOR VIEW:
- This is an INTERIOR wall as seen from INSIDE the room
- Vertical wall with ${height}px height
- You are INSIDE the room looking at this wall - show the INNER surface
- Wall orientation: runs diagonally upper-left to lower-right in screen space

CRITICAL - INTERIOR SURFACE:
- Show the INSIDE face of the wall (what you'd see standing IN the room)
- Interior wood paneling/wainscoting facing TOWARD the viewer
- The wall surface should face TOWARD bottom-left (into the room center)
- DO NOT show exterior/outside surface

Structure:
- Top edge follows 2:1 isometric slope going down-right
- Vertical interior surface with wood texture
- Bottom anchored at floor level (Y=${height})
- Light from top-left illuminates the interior surface

`;
  } else if (tileType === 'wall-w' || tileType === 'wall_w') {
    prompt += `WEST WALL TILE - INTERIOR VIEW:
- This is an INTERIOR wall as seen from INSIDE the room
- Vertical wall with ${height}px height
- You are INSIDE the room looking at this wall - show the INNER surface
- Wall orientation: runs diagonally upper-right to lower-left in screen space

CRITICAL - INTERIOR SURFACE:
- Show the INSIDE face of the wall (what you'd see standing IN the room)
- Interior wood paneling/wainscoting facing TOWARD the viewer
- The wall surface should face TOWARD bottom-right (into the room center)
- DO NOT show exterior/outside surface

Structure:
- Top edge follows 2:1 isometric slope going down-left
- Vertical interior surface with wood texture
- Bottom anchored at floor level (Y=${height})
- This wall is slightly shadowed (angled away from top-left light)

`;
  } else if (tileType === 'wall-s' || tileType === 'wall_s') {
    prompt += `SOUTH WALL TILE (bottom-left edge of room):
- Vertical wall with ${height}px height
- In isometric view, this wall runs along the BOTTOM-LEFT diagonal edge
- The wall FACE points INWARD (toward top-right, into the room)
- Structure:
  * Wall runs diagonally from upper-left to lower-right in screen space
  * You see the BACK of the wall from outside, or inner face from inside
  * For room interior view: show the inner face of the wall
  * Bottom anchored at floor level
- Match north wall style but mirrored orientation

`;
  } else if (tileType === 'wall-e' || tileType === 'wall_e') {
    prompt += `EAST WALL TILE (bottom-right edge of room):
- Vertical wall with ${height}px height
- In isometric view, this wall runs along the BOTTOM-RIGHT diagonal edge
- The wall FACE points INWARD (toward top-left, into the room)
- Structure:
  * Wall runs diagonally from upper-right to lower-left in screen space
  * You see the BACK of the wall from outside, or inner face from inside
  * For room interior view: show the inner face of the wall
  * Bottom anchored at floor level
- Match west wall style but mirrored orientation

`;
  } else if (tileType === 'wall_left' || tileType === 'wall-left') {
    prompt += `LEFT-FACING WALL TILE:
- Vertical wall, ${height}px height
- Wall face visible on the LEFT side, recedes to the RIGHT

`;
  } else if (tileType === 'wall_right' || tileType === 'wall-right') {
    prompt += `RIGHT-FACING WALL TILE:
- Vertical wall, ${height}px height
- Wall face visible on the RIGHT side, recedes to the LEFT

`;
  } else if (tileType.startsWith('corner')) {
    const pos = tileType.replace('corner_', '').replace('corner-', '').toUpperCase();
    prompt += `${pos} CORNER TILE - INTERIOR VIEW:
- This is a corner as seen from INSIDE the room
- Two INTERIOR wall surfaces meeting at 90 degrees
- Height: ${height} pixels (matches wall tiles)
- You are standing IN the room looking at this corner

CRITICAL - INTERIOR SURFACES:
- Show the INSIDE faces of both walls meeting at this corner
- Both wall surfaces face TOWARD the room center (toward the viewer)
- Interior wood paneling on both visible faces
- DO NOT show exterior surfaces

${pos === 'NW' ? `NW Corner (TOP vertex of room):
- This is the back corner of the room (farthest from viewer)
- Left wall surface faces toward bottom-right
- Right wall surface faces toward bottom-left
- Corner vertex points TOWARD the viewer
- You see two interior walls meeting, forming a corner that "sticks out" toward you` : ''}
${pos === 'NE' ? `NE Corner (RIGHT vertex of room):
- Right side back corner
- Wall surfaces face inward toward room center
- Corner connects north wall to open edge` : ''}
${pos === 'SW' ? `SW Corner (LEFT vertex of room):
- Left side corner
- Wall surfaces face inward toward room center
- Corner connects west wall to open edge` : ''}
${pos === 'SE' ? `SE Corner (BOTTOM vertex - front of room):
- This is the front corner (closest to viewer)
- Minimal height or floor-level corner marker
- Marks the front edge of the room` : ''}

- Base sits at bottom of image (Y=${height})
- MUST seamlessly connect to adjacent wall tiles
- Match the interior wood style of the walls

`;
  }

  prompt += `MATCH the exact style, colors, wood grain direction, and lighting of other tiles in this set.
Output: EXACTLY ${width}x${height} pixels, PNG with transparent background.
The tile content should fill the appropriate shape with NO empty space around it.`;

  return prompt;
}

// ============================================================================
// LEGACY SINGLE TILE GENERATION
// ============================================================================
// Generates each tile type with a SEPARATE AI call.
// This can result in style inconsistencies because each tile is created
// independently without visual context of the others.
//
// Use --legacy flag in CLI to enable this mode.
// Prefer the Tile Sheet Generation (default) for better style consistency.
//
// Functions:
//   - generateRoom(): Main entry point for legacy generation
//   - buildTilePrompt(): Creates prompts for individual tiles
// ============================================================================

/**
 * [LEGACY] Generate a complete room with tiles, props, and Tiled export
 * NOTE: This uses separate AI calls for each tile type, which may result
 * in style inconsistencies. Consider using generateRoomWithSheet() instead.
 *
 * @param {string} theme - Room theme (e.g., "cozy office", "stone dungeon")
 * @param {Object} options - Generation options
 * @param {string} options.layout - Layout template name or 'procedural' (default: 'office-small')
 * @param {number} options.width - Room width in tiles (for procedural, default: 6)
 * @param {number} options.height - Room height in tiles (for procedural, default: 5)
 * @param {string[]} options.props - Props to generate (e.g., ['desk', 'chair'])
 * @param {string} options.tileSize - Tile dimensions "WxH" (default: "64x32")
 * @param {string} options.style - Art style (default: "isometric pixel art")
 * @param {string|Buffer} options.referenceImage - Optional reference for style
 * @param {Array} options.projectReferences - Project style references
 * @param {string} options.outputDir - Output directory (default: "room/")
 * @param {string} options.apiKey - Gemini API key
 * @param {boolean} options.verbose - Enable verbose logging
 * @returns {Promise<Object>} Generated room info with paths to all outputs
 */
export async function generateRoom(theme, options = {}) {
  const {
    layout = 'office-small',
    width = 6,
    height = 5,
    props = [],
    tileSize = '64x32',
    style = 'isometric pixel art',
    referenceImage,
    projectReferences = [],
    outputDir = 'room/',
    apiKey = process.env.GEMINI_API_KEY,
    verbose = false,
    enableQC = false,
    autoFix = false,
    qcThreshold = 70
  } = options;

  if (!apiKey) {
    throw new Error('GEMINI_API_KEY environment variable is required');
  }

  const [tileWidth, tileHeight] = tileSize.split('x').map(Number);

  if (verbose) {
    console.log(`Generating room: ${theme}`);
    console.log(`  Layout: ${layout}`);
    console.log(`  Style: ${style}`);
    console.log(`  Tile size: ${tileSize}`);
  }

  // Ensure output directory exists
  await fsPromises.mkdir(outputDir, { recursive: true });

  // 1. Get or generate layout
  let roomLayout;
  if (layout === 'procedural') {
    roomLayout = generateLayout(width, height, { addProps: props.length === 0 });
    if (verbose) {
      console.log(`  Generated procedural layout: ${width}x${height}`);
    }
  } else {
    roomLayout = getTemplate(layout);
    if (!roomLayout) {
      throw new Error(`Unknown layout template: ${layout}. Use 'procedural' or one of: office-small, office-large, hallway`);
    }
    if (verbose) {
      console.log(`  Using template: ${layout} (${roomLayout.width}x${roomLayout.height})`);
    }
  }

  // Validate layout
  const validation = validateLayout(roomLayout);
  if (!validation.valid) {
    throw new Error(`Invalid layout: ${validation.errors.join(', ')}`);
  }

  // 2. Get unique tile types needed
  const tileTypes = getUniqueTileTypes(roomLayout);
  if (verbose) {
    console.log(`  Tile types needed: ${tileTypes.join(', ')}`);
  }

  // 3. Map tile type names to tileset include format
  const includeTypes = new Set();
  for (const tileType of tileTypes) {
    if (tileType === 'floor') {
      includeTypes.add('floor');
    } else if (tileType.startsWith('wall-')) {
      includeTypes.add('walls');
    } else if (tileType.startsWith('corner-')) {
      includeTypes.add('corners');
    }
  }

  // 4. Generate tiles using existing generateTileset
  if (verbose) {
    console.log(`  Generating tileset...`);
  }

  const tilesetResult = await generateTileset(theme, {
    include: Array.from(includeTypes),
    tileSize,
    style,
    referenceImage,
    projectReferences,
    outputDir: path.join(outputDir, 'tiles'),
    apiKey,
    verbose
  });

  // 5. Load generated tile images for atlas
  const tileBuffers = [];

  // Map from layout tile type names to actual generated file names
  // Direct 1:1 mapping - each wall direction gets its own tile
  const tileNameMapping = {
    'floor': 'floor',
    'wall-n': 'wall_n',       // North wall (top-right edge)
    'wall-s': 'wall_s',       // South wall (bottom-left edge)
    'wall-e': 'wall_e',       // East wall (bottom-right edge)
    'wall-w': 'wall_w',       // West wall (top-left edge)
    'corner-nw': 'corner_nw',
    'corner-ne': 'corner_ne',
    'corner-sw': 'corner_sw',
    'corner-se': 'corner_se'
  };

  // Collect unique tiles needed (deduplicated)
  const uniqueTileFiles = new Set();
  for (const tileType of tileTypes) {
    const mappedName = tileNameMapping[tileType] || tileType.replace(/-/g, '_');
    uniqueTileFiles.add(mappedName);
  }

  for (const tileName of uniqueTileFiles) {
    const tilePath = path.join(outputDir, 'tiles', `${tileName}.png`);
    if (fs.existsSync(tilePath)) {
      const buffer = await fsPromises.readFile(tilePath);
      tileBuffers.push({ name: tileName, buffer });
    } else if (verbose) {
      console.log(`  Warning: Tile file not found: ${tilePath}`);
    }
  }

  if (tileBuffers.length === 0) {
    throw new Error('No tiles were generated successfully');
  }

  // 6. Create atlas
  if (verbose) {
    console.log(`  Creating texture atlas...`);
  }

  const atlasInfo = await createAtlas(tileBuffers, {
    tileWidth,
    tileHeight,
    columns: 8,
    padding: 0
  });

  // Save atlas image
  const atlasPath = path.join(outputDir, 'atlas.png');
  await fsPromises.writeFile(atlasPath, atlasInfo.buffer);

  if (verbose) {
    console.log(`    Atlas size: ${atlasInfo.width}x${atlasInfo.height}`);
    console.log(`    Tiles in atlas: ${atlasInfo.tileCount}`);
  }

  // 7. Generate props if requested
  const generatedProps = [];
  if (props.length > 0) {
    if (verbose) {
      console.log(`  Generating ${props.length} props...`);
    }

    const propsDir = path.join(outputDir, 'props');
    await fsPromises.mkdir(propsDir, { recursive: true });

    for (const propName of props) {
      try {
        const propPath = path.join(propsDir, `${propName.replace(/\s+/g, '_')}.png`);
        await generateStaticAsset(`${theme} ${propName}`, {
          referenceImage,
          projectReferences,
          style,
          outputPath: propPath,
          apiKey,
          verbose: false
        });

        generatedProps.push({
          name: propName,
          file: path.basename(propPath),
          path: propPath
        });

        if (verbose) {
          console.log(`    Generated: ${propName}`);
        }
      } catch (err) {
        if (verbose) {
          console.log(`    Warning: Failed to generate prop "${propName}": ${err.message}`);
        }
      }
    }
  }

  // 8. Generate Tiled JSON files
  if (verbose) {
    console.log(`  Generating Tiled JSON files...`);
  }

  // Build atlasInfo with proper tile name mappings for the layout
  const layoutAtlasInfo = {
    ...atlasInfo,
    tilePositions: {}
  };

  // Map layout tile types to atlas GIDs
  for (const tileType of tileTypes) {
    const mappedName = tileNameMapping[tileType] || tileType.replace(/-/g, '_');
    if (atlasInfo.tilePositions[mappedName]) {
      layoutAtlasInfo.tilePositions[tileType] = atlasInfo.tilePositions[mappedName];
    }
  }

  // Use atlas tileHeight (max height) for Tiled map to match tileset
  // This ensures map and tileset have consistent tile dimensions
  const tiledMap = generateTiledMap(roomLayout, layoutAtlasInfo, {
    tileWidth,
    tileHeight: atlasInfo.tileHeight,  // Use max height from atlas, not base height
    tilesetSource: 'tileset.json',
    props: generatedProps
  });

  const tilesetJSON = generateTilesetJSON(atlasInfo, {
    name: `${theme.replace(/\s+/g, '-')}-tileset`,
    imageSource: 'atlas.png'
  });

  // Save Tiled files
  const roomJsonPath = path.join(outputDir, 'room.json');
  const tilesetJsonPath = path.join(outputDir, 'tileset.json');

  await fsPromises.writeFile(roomJsonPath, JSON.stringify(tiledMap, null, 2));
  await fsPromises.writeFile(tilesetJsonPath, JSON.stringify(tilesetJSON, null, 2));

  // 9. Generate metadata
  const metadata = {
    theme,
    layout: layout === 'procedural' ? 'procedural' : layout,
    roomSize: { width: roomLayout.width, height: roomLayout.height },
    tileSize: { width: tileWidth, height: tileHeight },
    style,
    generated: new Date().toISOString(),
    files: {
      map: 'room.json',
      tileset: 'tileset.json',
      atlas: 'atlas.png',
      tilesDir: 'tiles/',
      propsDir: props.length > 0 ? 'props/' : null
    },
    tileCount: atlasInfo.tileCount,
    propCount: generatedProps.length
  };

  const metadataPath = path.join(outputDir, 'metadata.json');
  await fsPromises.writeFile(metadataPath, JSON.stringify(metadata, null, 2));

  if (verbose) {
    console.log(`\nRoom generation complete!`);
    console.log(`  Output: ${outputDir}`);
    console.log(`  Room size: ${roomLayout.width}x${roomLayout.height} tiles`);
    console.log(`  Tiles generated: ${atlasInfo.tileCount}`);
    console.log(`  Props generated: ${generatedProps.length}`);
  }

  // Optional QC
  if (enableQC) {
    const { roomQC: runQC } = await import('./roomQC.js');
    const { saveRoomPreview } = await import('./preview.js');

    // Generate preview first
    await saveRoomPreview({ outputDir, layout: roomLayout, tiledMapPath: roomJsonPath, tilesetPath: tilesetJsonPath, metadata }, { verbose });

    // Run QC
    const qcReport = await runQC(
      { outputDir, layout: roomLayout, tiledMapPath: roomJsonPath, tilesetPath: tilesetJsonPath, metadata, tiles: tilesetResult.tiles },
      { verbose, autoFix, passThreshold: qcThreshold, apiKey }
    );

    if (verbose) {
      console.log(`  QC Score: ${qcReport.finalScore}/100, Passed: ${qcReport.passed}`);
    }
  }

  return {
    outputDir,
    layout: roomLayout,
    atlasPath,
    tiledMapPath: roomJsonPath,
    tilesetPath: tilesetJsonPath,
    metadataPath,
    tiles: tilesetResult.tiles,
    props: generatedProps,
    metadata
  };
}
