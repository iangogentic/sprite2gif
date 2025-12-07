import sharp from 'sharp';
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import puppeteer from 'puppeteer';
import { gridToScreen, calculateRoomBounds } from './isometric.js';

/**
 * Render a room preview to PNG buffer using Sharp
 * This is the primary rendering method - fast and works without browser
 *
 * @param {Object} layout - Room layout object with tiles grid
 * @param {Object} tileBuffers - Map of tileName -> PNG buffer
 * @param {Object} options - Rendering options
 * @returns {Promise<Buffer>} PNG buffer of rendered room
 */
export async function renderRoomToBuffer(layout, tileBuffers, options = {}) {
  const {
    tileWidth = 64,
    tileHeight = 32,  // Base floor height
    maxTileHeight = 64,  // Max height for walls
    backgroundColor = { r: 26, g: 26, b: 46, alpha: 255 }, // Dark blue-gray
    verbose = false
  } = options;

  // Calculate canvas dimensions - use maxTileHeight for vertical bounds to fit walls
  const bounds = calculateRoomBounds(layout.width, layout.height, tileWidth, tileHeight);
  // Add extra height for wall tiles that extend above the floor plane
  const extraWallHeight = maxTileHeight - tileHeight;
  bounds.height += extraWallHeight;
  bounds.offsetY += extraWallHeight;  // Shift everything down to make room for walls

  if (verbose) {
    console.log(`  Canvas size: ${bounds.width}x${bounds.height}`);
    console.log(`  Offset: (${bounds.offsetX}, ${bounds.offsetY})`);
  }

  // Build composite operations - render back to front (painter's algorithm)
  const composites = [];

  for (let y = 0; y < layout.height; y++) {
    for (let x = 0; x < layout.width; x++) {
      const tileName = layout.tiles[y][x];
      if (tileName === 'empty' || !tileName) continue;

      // Map layout tile names to actual tile buffer keys
      const bufferKey = mapTileNameToBufferKey(tileName);
      const tileBuffer = tileBuffers[bufferKey];

      if (!tileBuffer) {
        if (verbose) console.log(`  Warning: Missing tile buffer for ${tileName} (${bufferKey})`);
        continue;
      }

      const screenPos = gridToScreen(x, y, tileWidth, tileHeight);

      // Get actual tile height - walls/corners are taller than floors
      let actualTileHeight = tileHeight;
      try {
        const meta = await sharp(tileBuffer).metadata();
        actualTileHeight = meta.height;
      } catch (e) {
        // Use default height
      }

      // Adjust Y position for taller tiles (walls extend UPWARD from floor plane)
      // Taller tiles need to be rendered higher so their bottom aligns with floor
      const heightDiff = actualTileHeight - tileHeight;

      composites.push({
        input: tileBuffer,
        left: Math.round(screenPos.x + bounds.offsetX),
        top: Math.round(screenPos.y + bounds.offsetY - heightDiff)  // Subtract height diff to raise walls
      });
    }
  }

  if (verbose) {
    console.log(`  Compositing ${composites.length} tiles...`);
  }

  // Create canvas and composite all tiles
  const previewBuffer = await sharp({
    create: {
      width: bounds.width,
      height: bounds.height,
      channels: 4,
      background: backgroundColor
    }
  })
    .composite(composites)
    .png()
    .toBuffer();

  return previewBuffer;
}

/**
 * Map layout tile names to buffer keys
 * Layout uses: floor, wall-n, wall-s, wall-e, wall-w, corner-nw, etc.
 * Buffers use: floor, wall_n, wall_s, wall_e, wall_w, corner_nw, etc.
 */
function mapTileNameToBufferKey(tileName) {
  const mapping = {
    'floor': 'floor',
    'wall-n': 'wall_n',
    'wall-s': 'wall_s',
    'wall-e': 'wall_e',
    'wall-w': 'wall_w',
    'corner-nw': 'corner_nw',
    'corner-ne': 'corner_ne',
    'corner-sw': 'corner_sw',
    'corner-se': 'corner_se'
  };
  return mapping[tileName] || tileName.replace(/-/g, '_');
}

/**
 * Generate an interactive HTML preview file
 *
 * @param {Object} roomData - room.json data
 * @param {Object} tilesetData - tileset.json data
 * @param {Object} options - Generation options
 * @returns {string} HTML content
 */
export function generatePreviewHTML(roomData, tilesetData, options = {}) {
  const {
    atlasPath = 'atlas.png',
    title = 'Room Preview',
    baseTileHeight = 32  // Floor height for isometric calculations
  } = options;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${title}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #1a1a2e;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      color: #fff;
    }
    .controls {
      position: fixed;
      top: 10px;
      left: 10px;
      background: rgba(0,0,0,0.7);
      padding: 10px;
      border-radius: 8px;
      z-index: 100;
    }
    .controls button {
      background: #4a4a6a;
      border: none;
      color: white;
      padding: 8px 16px;
      margin: 2px;
      border-radius: 4px;
      cursor: pointer;
    }
    .controls button:hover { background: #6a6a8a; }
    .info {
      position: fixed;
      top: 10px;
      right: 10px;
      background: rgba(0,0,0,0.7);
      padding: 10px;
      border-radius: 8px;
      font-size: 12px;
    }
    #canvas-container {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 60px 20px 20px;
      overflow: hidden;
    }
    canvas {
      border: 1px solid #333;
      cursor: grab;
    }
    canvas:active { cursor: grabbing; }
  </style>
</head>
<body>
  <div class="controls">
    <button onclick="zoomIn()">+ Zoom</button>
    <button onclick="zoomOut()">- Zoom</button>
    <button onclick="resetView()">Reset</button>
    <button onclick="toggleGrid()">Grid</button>
    <button onclick="exportPNG()">Export PNG</button>
  </div>
  <div class="info">
    <div>Room: ${roomData.width}x${roomData.height}</div>
    <div>Tiles: ${tilesetData.tilewidth}x${tilesetData.tileheight}</div>
    <div id="hover-info">Hover over tile</div>
  </div>
  <div id="canvas-container">
    <canvas id="canvas"></canvas>
  </div>

  <script>
    // Embedded data
    const ROOM = ${JSON.stringify(roomData)};
    const TILESET = ${JSON.stringify(tilesetData)};
    const BASE_TILE_HEIGHT = ${baseTileHeight};  // Floor height for isometric positioning

    // State
    let zoom = 2;
    let offsetX = 0, offsetY = 0;
    let isDragging = false;
    let dragStartX, dragStartY;
    let showGrid = false;

    // Canvas setup
    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d');

    // Load atlas
    const atlas = new Image();
    atlas.src = '${atlasPath}';
    atlas.onload = () => {
      resetView();
      render();
    };

    // Isometric math - use BASE_TILE_HEIGHT for positioning, not atlas cell height
    function gridToScreen(gx, gy) {
      const tw = TILESET.tilewidth;
      const th = BASE_TILE_HEIGHT;  // Use base floor height for proper isometric positions
      return {
        x: (gx - gy) * (tw / 2),
        y: (gx + gy) * (th / 2)
      };
    }

    function screenToGrid(sx, sy) {
      const tw = TILESET.tilewidth;
      const th = TILESET.tileheight;
      return {
        gx: Math.floor((sx / (tw / 2) + sy / (th / 2)) / 2),
        gy: Math.floor((sy / (th / 2) - sx / (tw / 2)) / 2)
      };
    }

    function calculateBounds() {
      const tw = TILESET.tilewidth;
      const th = BASE_TILE_HEIGHT;  // Use base height for isometric layout
      const cellHeight = TILESET.tileheight;  // Atlas cell height (includes wall height)
      const w = ROOM.width;
      const h = ROOM.height;
      const extraHeight = cellHeight - th;  // Extra space for walls above floor plane
      return {
        width: (w + h) * (tw / 2),
        height: (w + h) * (th / 2) + cellHeight + extraHeight,
        offsetX: h * (tw / 2),
        offsetY: extraHeight  // Offset to make room for walls extending upward
      };
    }

    function render() {
      const bounds = calculateBounds();
      canvas.width = bounds.width * zoom;
      canvas.height = bounds.height * zoom;

      ctx.imageSmoothingEnabled = false;
      ctx.save();
      ctx.scale(zoom, zoom);
      ctx.translate(offsetX, offsetY);

      // Clear
      ctx.fillStyle = '#1a1a2e';
      ctx.fillRect(-offsetX, -offsetY, bounds.width, bounds.height);

      // Get tile layer data
      const tileLayer = ROOM.layers.find(l => l.type === 'tilelayer');
      if (!tileLayer) return;

      const data = tileLayer.data;
      const tw = TILESET.tilewidth;
      const cellHeight = TILESET.tileheight;  // Atlas cell height (64)
      const th = BASE_TILE_HEIGHT;  // Base floor height for grid (32)
      const cols = TILESET.columns || 8;
      const heightDiff = cellHeight - th;  // Difference for wall adjustment

      // Render tiles
      for (let y = 0; y < ROOM.height; y++) {
        for (let x = 0; x < ROOM.width; x++) {
          const gid = data[y * ROOM.width + x];
          if (gid === 0) continue;

          const tileIndex = gid - 1;
          const sx = (tileIndex % cols) * tw;
          const sy = Math.floor(tileIndex / cols) * cellHeight;

          const pos = gridToScreen(x, y);
          const dx = pos.x + bounds.offsetX;
          // Adjust Y: walls extend upward from floor plane
          // The atlas has taller cells (64px) with floor content at bottom
          // We draw from the position and let the extra height extend upward
          const dy = pos.y + bounds.offsetY - heightDiff;

          ctx.drawImage(atlas, sx, sy, tw, cellHeight, dx, dy, tw, cellHeight);

          // Grid overlay (draw diamond at floor level)
          if (showGrid) {
            const gridY = pos.y + bounds.offsetY;
            ctx.strokeStyle = 'rgba(255,255,255,0.3)';
            ctx.beginPath();
            ctx.moveTo(dx + tw/2, gridY);
            ctx.lineTo(dx + tw, gridY + th/2);
            ctx.lineTo(dx + tw/2, gridY + th);
            ctx.lineTo(dx, gridY + th/2);
            ctx.closePath();
            ctx.stroke();
          }
        }
      }

      ctx.restore();
    }

    // Controls
    function zoomIn() { zoom = Math.min(zoom * 1.5, 8); render(); }
    function zoomOut() { zoom = Math.max(zoom / 1.5, 0.5); render(); }
    function resetView() { zoom = 2; offsetX = 0; offsetY = 0; render(); }
    function toggleGrid() { showGrid = !showGrid; render(); }
    function exportPNG() {
      const link = document.createElement('a');
      link.download = 'room-preview.png';
      link.href = canvas.toDataURL('image/png');
      link.click();
    }

    // Pan controls
    canvas.addEventListener('mousedown', (e) => {
      isDragging = true;
      dragStartX = e.clientX - offsetX * zoom;
      dragStartY = e.clientY - offsetY * zoom;
    });

    canvas.addEventListener('mousemove', (e) => {
      if (isDragging) {
        offsetX = (e.clientX - dragStartX) / zoom;
        offsetY = (e.clientY - dragStartY) / zoom;
        render();
      }

      // Hover info
      const rect = canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left) / zoom - offsetX;
      const y = (e.clientY - rect.top) / zoom - offsetY;
      const bounds = calculateBounds();
      const grid = screenToGrid(x - bounds.offsetX, y);

      if (grid.gx >= 0 && grid.gx < ROOM.width && grid.gy >= 0 && grid.gy < ROOM.height) {
        const tileLayer = ROOM.layers.find(l => l.type === 'tilelayer');
        const gid = tileLayer?.data[grid.gy * ROOM.width + grid.gx] || 0;
        document.getElementById('hover-info').textContent =
          \`Tile (\${grid.gx}, \${grid.gy}) GID: \${gid}\`;
      }
    });

    canvas.addEventListener('mouseup', () => isDragging = false);
    canvas.addEventListener('mouseleave', () => isDragging = false);

    // Zoom with wheel
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.deltaY < 0) zoomIn();
      else zoomOut();
    });
  </script>
</body>
</html>`;
}

/**
 * Save preview files for a room
 *
 * @param {Object} roomResult - Result from generateRoom()
 * @param {Object} options - Options
 * @returns {Promise<Object>} Paths to generated preview files
 */
export async function saveRoomPreview(roomResult, options = {}) {
  const {
    outputDir = roomResult.outputDir,
    verbose = false
  } = options;

  const paths = {};

  // Load room.json and tileset.json
  const roomData = JSON.parse(await fsPromises.readFile(roomResult.tiledMapPath, 'utf-8'));
  const tilesetData = JSON.parse(await fsPromises.readFile(roomResult.tilesetPath, 'utf-8'));

  // Generate HTML preview
  const htmlContent = generatePreviewHTML(roomData, tilesetData, {
    title: `Room Preview: ${roomResult.metadata?.theme || 'room'}`
  });

  const htmlPath = path.join(outputDir, 'preview.html');
  await fsPromises.writeFile(htmlPath, htmlContent);
  paths.html = htmlPath;

  if (verbose) {
    console.log(`  Generated: ${htmlPath}`);
  }

  // Load tile buffers for PNG render
  const tileBuffers = {};
  const tilesDir = path.join(outputDir, 'tiles');
  const tileFiles = await fsPromises.readdir(tilesDir);

  for (const file of tileFiles) {
    if (file.endsWith('.png')) {
      const name = path.basename(file, '.png');
      tileBuffers[name] = await fsPromises.readFile(path.join(tilesDir, file));
    }
  }

  // Render to PNG
  const previewBuffer = await renderRoomToBuffer(roomResult.layout, tileBuffers, {
    verbose
  });

  const pngPath = path.join(outputDir, 'preview.png');
  await fsPromises.writeFile(pngPath, previewBuffer);
  paths.png = pngPath;

  if (verbose) {
    console.log(`  Generated: ${pngPath}`);
  }

  return paths;
}

/**
 * Render room preview using Puppeteer (for high-fidelity screenshots)
 * Falls back to Sharp rendering if Puppeteer fails
 *
 * @param {string} htmlPath - Path to preview.html
 * @param {string} outputPath - Path to save screenshot
 * @returns {Promise<Buffer>} PNG buffer
 */
export async function renderWithPuppeteer(htmlPath, outputPath, options = {}) {
  const { verbose = false } = options;

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    await page.goto(`file://${path.resolve(htmlPath)}`, {
      waitUntil: 'networkidle0'
    });

    // Wait for atlas to load
    await page.waitForFunction('document.querySelector("canvas").width > 0', {
      timeout: 10000
    });

    // Get canvas element and screenshot
    const canvas = await page.$('canvas');
    const buffer = await canvas.screenshot({ type: 'png' });

    if (outputPath) {
      await fsPromises.writeFile(outputPath, buffer);
    }

    if (verbose) {
      console.log(`  Puppeteer screenshot: ${outputPath}`);
    }

    return buffer;

  } catch (error) {
    if (verbose) {
      console.log(`  Puppeteer failed: ${error.message}`);
    }
    throw error;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}
