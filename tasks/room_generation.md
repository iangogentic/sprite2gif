# Task: Room Generation with Tiled Export

> **Status:** IN PROGRESS
> **Priority:** High
> **Depends On:** tile_system.md (Phase 1-2 complete)

---

## Goal

Generate complete game-ready rooms that export to Tiled JSON format, compatible with:
- GPU Cats (C++/OpenGL via tmxlite or nlohmann/json)
- Unity (native Tiled import)
- Godot (native Tiled import)
- Any engine with JSON parser

---

## Architecture Overview

```
room command
    │
    ├── layout.js ──────────► Room layout (template or procedural)
    │
    ├── generator.js ───────► Generate tiles via AI (reuses generateTileset)
    │   │
    │   └── generateStaticAsset() ► Generate props
    │
    ├── atlas.js ───────────► Combine tiles into spritesheet
    │
    ├── tiled.js ───────────► Export Tiled JSON format
    │
    └── isometric.js ───────► Coordinate conversions
```

---

## Module 1: layout.js

**Purpose:** Define room layouts via templates or procedural generation.

### Exports

```javascript
/**
 * Room layout templates
 */
export const ROOM_TEMPLATES = {
  'office-small': { /* 6x5 layout */ },
  'office-large': { /* 10x8 layout */ },
  'hallway': { /* 3x8 layout */ }
};

/**
 * Get a room layout from template
 * @param {string} templateName - Template name
 * @returns {Object} Layout object { width, height, tiles, props }
 */
export function getTemplate(templateName);

/**
 * Generate a procedural room layout
 * @param {number} width - Room width in tiles
 * @param {number} height - Room height in tiles
 * @param {Object} options - Generation options
 * @returns {Object} Layout object
 */
export function generateLayout(width, height, options = {});

/**
 * Validate a room layout
 * @param {Object} layout - Layout to validate
 * @returns {Object} { valid: boolean, errors: string[] }
 */
export function validateLayout(layout);

/**
 * Extract unique tile types from layout
 * @param {Object} layout - Room layout
 * @returns {string[]} Array of unique tile type names
 */
export function getUniqueTileTypes(layout);

/**
 * List available template names
 * @returns {string[]}
 */
export function listTemplates();
```

### Template Format

```javascript
{
  name: 'office-small',
  width: 6,
  height: 5,
  tiles: [
    ['corner-nw', 'wall-n', 'wall-n', 'wall-n', 'wall-n', 'corner-ne'],
    ['wall-w', 'floor', 'floor', 'floor', 'floor', 'wall-e'],
    ['wall-w', 'floor', 'floor', 'floor', 'floor', 'wall-e'],
    ['wall-w', 'floor', 'floor', 'floor', 'floor', 'wall-e'],
    ['corner-sw', 'wall-s', 'wall-s', 'wall-s', 'wall-s', 'corner-se']
  ],
  defaultProps: [
    { type: 'desk', gridX: 2, gridY: 2 },
    { type: 'chair', gridX: 2, gridY: 3 }
  ]
}
```

### Tile Type Mapping

```javascript
const TILE_TYPES = {
  'floor': { category: 'floor' },
  'wall-n': { category: 'wall', direction: 'north' },
  'wall-s': { category: 'wall', direction: 'south' },
  'wall-e': { category: 'wall', direction: 'east' },
  'wall-w': { category: 'wall', direction: 'west' },
  'corner-nw': { category: 'corner', position: 'northwest' },
  'corner-ne': { category: 'corner', position: 'northeast' },
  'corner-sw': { category: 'corner', position: 'southwest' },
  'corner-se': { category: 'corner', position: 'southeast' }
};
```

---

## Module 2: atlas.js

**Purpose:** Combine multiple tile images into a single spritesheet.

### Exports

```javascript
import sharp from 'sharp';

/**
 * Create a texture atlas from tile images
 * @param {Array} tiles - Array of { name, buffer } objects
 * @param {Object} options - Atlas options
 * @param {number} options.tileWidth - Width of each tile (default: 64)
 * @param {number} options.tileHeight - Height of each tile (default: 32)
 * @param {number} options.columns - Columns in atlas (default: 8)
 * @param {number} options.padding - Padding between tiles (default: 0)
 * @returns {Promise<Object>} { buffer, width, height, tilePositions }
 */
export async function createAtlas(tiles, options = {});

/**
 * Get tile position in atlas by name
 * @param {Object} atlasInfo - Atlas info from createAtlas
 * @param {string} tileName - Tile name
 * @returns {Object} { x, y, width, height, gid }
 */
export function getTilePosition(atlasInfo, tileName);
```

### Implementation Notes

- Use Sharp's `composite()` for combining images
- Create transparent canvas with `sharp({ create: { ... } })`
- Return tile positions for Tiled tileset

---

## Module 3: tiled.js

**Purpose:** Export Tiled-compatible JSON files.

### Exports

```javascript
/**
 * Generate Tiled map JSON
 * @param {Object} layout - Room layout
 * @param {Object} atlasInfo - Atlas info from createAtlas
 * @param {Object} options - Export options
 * @returns {Object} Tiled map JSON object
 */
export function generateTiledMap(layout, atlasInfo, options = {});

/**
 * Generate Tiled tileset JSON
 * @param {Object} atlasInfo - Atlas info
 * @param {Object} options - Options
 * @returns {Object} Tiled tileset JSON object
 */
export function generateTilesetJSON(atlasInfo, options = {});

/**
 * Convert layout tile types to Tiled GIDs
 * @param {Object} layout - Room layout
 * @param {Object} atlasInfo - Atlas info with tile positions
 * @returns {number[]} Flat array of tile GIDs
 */
export function layoutToTiledData(layout, atlasInfo);
```

### Tiled Map Format (v1.10)

```json
{
  "version": "1.10",
  "tiledversion": "1.10.0",
  "orientation": "isometric",
  "renderorder": "right-down",
  "width": 6,
  "height": 5,
  "tilewidth": 64,
  "tileheight": 32,
  "infinite": false,
  "layers": [
    {
      "id": 1,
      "name": "tiles",
      "type": "tilelayer",
      "x": 0,
      "y": 0,
      "width": 6,
      "height": 5,
      "visible": true,
      "opacity": 1,
      "data": [1, 2, 2, 2, 2, 3, 4, 5, 5, 5, 5, 6, ...]
    },
    {
      "id": 2,
      "name": "props",
      "type": "objectgroup",
      "objects": [
        {
          "id": 1,
          "name": "desk",
          "type": "prop",
          "x": 128,
          "y": 64,
          "width": 64,
          "height": 32,
          "visible": true
        }
      ]
    }
  ],
  "tilesets": [
    {
      "firstgid": 1,
      "source": "tileset.json"
    }
  ]
}
```

### Tiled Tileset Format

```json
{
  "name": "room-tileset",
  "tilewidth": 64,
  "tileheight": 32,
  "tilecount": 9,
  "columns": 8,
  "image": "atlas.png",
  "imagewidth": 512,
  "imageheight": 64
}
```

---

## Module 4: isometric.js

**Purpose:** Coordinate conversion utilities for isometric projection.

### Exports

```javascript
/**
 * Convert grid coordinates to isometric screen coordinates
 * @param {number} gridX - Grid X position
 * @param {number} gridY - Grid Y position
 * @param {number} tileWidth - Tile width in pixels
 * @param {number} tileHeight - Tile height in pixels
 * @returns {Object} { x, y } screen coordinates
 */
export function gridToScreen(gridX, gridY, tileWidth = 64, tileHeight = 32);

/**
 * Convert screen coordinates to grid coordinates
 * @param {number} screenX - Screen X position
 * @param {number} screenY - Screen Y position
 * @param {number} tileWidth - Tile width
 * @param {number} tileHeight - Tile height
 * @returns {Object} { gridX, gridY }
 */
export function screenToGrid(screenX, screenY, tileWidth = 64, tileHeight = 32);

/**
 * Calculate bounding box for room in screen space
 * @param {number} roomWidth - Room width in tiles
 * @param {number} roomHeight - Room height in tiles
 * @param {number} tileWidth - Tile width
 * @param {number} tileHeight - Tile height
 * @returns {Object} { width, height, offsetX, offsetY }
 */
export function calculateRoomBounds(roomWidth, roomHeight, tileWidth = 64, tileHeight = 32);
```

### Formulas

```javascript
// Grid to screen (isometric)
x = (gridX - gridY) * (tileWidth / 2)
y = (gridX + gridY) * (tileHeight / 2)

// Screen to grid
gridX = Math.floor((x / (tileWidth / 2) + y / (tileHeight / 2)) / 2)
gridY = Math.floor((y / (tileHeight / 2) - x / (tileWidth / 2)) / 2)
```

---

## Generator Integration: generateRoom()

Add to `src/generator.js`:

```javascript
/**
 * Generate a complete room with tiles, props, and Tiled export
 * @param {string} theme - Room theme (e.g., "cozy office")
 * @param {Object} options - Generation options
 * @returns {Promise<Object>} Generated room info
 */
export async function generateRoom(theme, options = {}) {
  const {
    layout = 'office-small',    // Template name or 'procedural'
    width = 6,                   // For procedural
    height = 5,                  // For procedural
    props = [],                  // Props to generate
    tileSize = '64x32',
    style = 'isometric pixel art',
    referenceImage,
    projectReferences = [],
    outputDir = 'room/',
    apiKey = process.env.GEMINI_API_KEY,
    verbose = false
  } = options;

  // 1. Get or generate layout
  const roomLayout = layout === 'procedural'
    ? generateLayout(width, height)
    : getTemplate(layout);

  // 2. Get unique tile types needed
  const tileTypes = getUniqueTileTypes(roomLayout);

  // 3. Generate tiles using existing generateTileset (multi-turn chat)
  const tiles = await generateTilesForRoom(theme, tileTypes, { ... });

  // 4. Generate props if requested
  const generatedProps = [];
  for (const prop of props) {
    const propImage = await generateStaticAsset(`${theme} ${prop}`, { ... });
    generatedProps.push({ name: prop, path: propImage });
  }

  // 5. Create atlas
  const atlasInfo = await createAtlas(tiles, { tileWidth, tileHeight });

  // 6. Export Tiled JSON
  const tiledMap = generateTiledMap(roomLayout, atlasInfo, { ... });
  const tilesetJSON = generateTilesetJSON(atlasInfo, { ... });

  // 7. Write files
  // ...

  return { outputDir, layout: roomLayout, tiles, props: generatedProps };
}
```

---

## CLI Command

Add to `src/index.js`:

```javascript
program
  .command('room <theme>')
  .description('Generate a complete room with Tiled export')
  .option('--layout <name>', 'Layout template or "procedural"', 'office-small')
  .option('--width <n>', 'Room width in tiles (procedural)', '6')
  .option('--height <n>', 'Room height in tiles (procedural)', '5')
  .option('--props <list>', 'Props to generate (comma-separated)', '')
  .option('--size <WxH>', 'Tile dimensions', '64x32')
  .option('--style <style>', 'Art style', 'isometric pixel art')
  .option('--reference <image>', 'Style reference image')
  .option('-o, --output <dir>', 'Output directory', 'room/')
  .option('--no-project', 'Skip project style references')
  .option('-v, --verbose', 'Verbose output')
  .action(async (theme, options) => {
    // Implementation
  });
```

---

## Test Plan

### Unit Tests (No AI)

#### layout.js tests
```javascript
// Test template retrieval
const layout = getTemplate('office-small');
assert(layout.width === 6);
assert(layout.height === 5);

// Test procedural generation
const procLayout = generateLayout(8, 6);
assert(procLayout.tiles.length === 6);
assert(procLayout.tiles[0].length === 8);

// Test validation
const result = validateLayout(layout);
assert(result.valid === true);

// Test unique tile extraction
const types = getUniqueTileTypes(layout);
assert(types.includes('floor'));
assert(types.includes('corner-nw'));
```

#### atlas.js tests
```javascript
// Create test tiles (1x1 pixel PNGs)
const testTiles = [
  { name: 'floor', buffer: createTestPNG() },
  { name: 'wall-n', buffer: createTestPNG() }
];

const atlas = await createAtlas(testTiles, { tileWidth: 64, tileHeight: 32 });
assert(atlas.buffer instanceof Buffer);
assert(atlas.tilePositions['floor'].gid === 1);
```

#### tiled.js tests
```javascript
const layout = getTemplate('office-small');
const mockAtlas = { /* mock */ };

const tiledMap = generateTiledMap(layout, mockAtlas);
assert(tiledMap.version === '1.10');
assert(tiledMap.orientation === 'isometric');
assert(tiledMap.layers.length >= 1);
```

#### isometric.js tests
```javascript
// Test coordinate conversion
const screen = gridToScreen(2, 1, 64, 32);
assert(screen.x === 32);  // (2-1) * 32
assert(screen.y === 48);  // (2+1) * 16

// Test reverse conversion
const grid = screenToGrid(32, 48, 64, 32);
assert(grid.gridX === 2);
assert(grid.gridY === 1);
```

### Integration Tests

```bash
# Test CLI command exists
node src/index.js room --help

# Test with template (will need API key for full test)
node src/index.js room "test office" --layout office-small -o test/room/ -v

# Verify output structure
ls test/room/
# Should show: room.json, tileset.json, atlas.png, metadata.json

# Validate Tiled JSON
cat test/room/room.json | jq '.version'
# Should output: "1.10"
```

---

## Success Criteria

- [ ] `layout.js` exports all functions, templates work
- [ ] `atlas.js` creates valid PNG spritesheet
- [ ] `tiled.js` outputs valid Tiled JSON format
- [ ] `isometric.js` coordinate conversion is accurate
- [ ] `generateRoom()` orchestrates full pipeline
- [ ] `room` CLI command works end-to-end
- [ ] Output opens in Tiled editor without errors
- [ ] All unit tests pass
- [ ] Integration tests pass
