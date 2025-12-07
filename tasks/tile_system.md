# Task: Environment Tile System

> **Status:** IN PROGRESS
> **Priority:** High

---

## Goal

Add environment tile generation to sprite2gif for creating seamless isometric game tiles (floors, walls, corners, transitions).

---

## Phase 1: Single Tile Generation

### generateTile() Function

Add to `src/generator.js`:

```javascript
/**
 * Generate a seamless environment tile
 * @param {string} description - Tile description (e.g., "grass floor")
 * @param {Object} options - Generation options
 * @param {string} options.type - Tile type: floor, wall-left, wall-right, corner-*
 * @param {string} options.tileSize - Tile dimensions "WxH" (default: "64x32")
 * @param {string} options.style - Art style (default: "isometric pixel art")
 * @param {boolean} options.seamless - Ensure seamless edges (default: true)
 * @param {string} options.referenceImage - Optional reference for style
 * @param {string} options.outputPath - Output file path
 * @returns {Promise<string>} Path to generated tile
 */
export async function generateTile(description, options = {})
```

### buildTilePrompt() Helper

```javascript
function buildTilePrompt(description, options) {
  const { type, tileSize, seamless, style } = options;
  const [width, height] = tileSize.split('x').map(Number);

  // Base prompt
  let prompt = `Generate a SEAMLESS ISOMETRIC TILE for a game environment:

TILE TYPE: ${type}
SUBJECT: ${description}
SIZE: ${width}x${height} pixels
STYLE: ${style}

`;

  // Seamless instructions
  if (seamless) {
    prompt += `SEAMLESS TILING REQUIREMENTS:
- Left edge MUST match right edge exactly when tiles are placed side by side
- Top edge MUST match bottom edge exactly when tiles are placed vertically
- All four corners must be compatible for diagonal tiling
- Use subtle, distributed patterns - NO unique focal points or landmarks
- Colors and textures must wrap seamlessly at all edges

`;
  }

  // Type-specific instructions
  if (type === 'floor') {
    prompt += `FLOOR TILE PERSPECTIVE:
- True isometric angle (2:1 width-to-height ratio)
- Diamond shape viewed from above at 45-degree angle
- Ground plane only - no vertical elements
- Subtle depth/shadow for 3D effect

`;
  } else if (type.startsWith('wall')) {
    const direction = type.includes('left') ? 'left' : 'right';
    prompt += `WALL TILE PERSPECTIVE:
- ${direction === 'left' ? 'Left-facing wall surface (recedes toward right)' : 'Right-facing wall surface (recedes toward left)'}
- Viewed from isometric angle
- Base connects to floor tiles
- Top edge connects to adjacent wall segments

`;
  } else if (type.startsWith('corner')) {
    prompt += `CORNER TILE:
- Connects two wall segments at 90-degree angle
- Must align with both wall-left and wall-right tiles
- Isometric perspective maintained

`;
  }

  prompt += `CRITICAL REQUIREMENTS:
1. Exact ${width}x${height} pixel dimensions
2. Transparent background (alpha channel)
3. Consistent lighting from top-left
4. Clean pixel edges
5. Designed for seamless repetition

OUTPUT: Single PNG tile, ${width}x${height} pixels, transparent background.`;

  return prompt;
}
```

### CLI Command

Add to `src/index.js`:

```javascript
program
  .command('tile <description>')
  .description('Generate a seamless environment tile')
  .option('--type <type>', 'Tile type: floor, wall-left, wall-right, corner-*', 'floor')
  .option('--size <WxH>', 'Tile dimensions', '64x32')
  .option('--style <style>', 'Art style', 'isometric pixel art')
  .option('--no-seamless', 'Disable seamless edge requirements')
  .option('--reference <image>', 'Reference image for style')
  .option('-o, --output <path>', 'Output path', 'tile.png')
  .option('--no-project', 'Skip project style references')
  .option('-v, --verbose', 'Verbose output')
  .action(async (description, options) => {
    // Implementation
  });
```

---

## Phase 2: Tileset Generation

### generateTileset() Function

```javascript
/**
 * Generate a coordinated set of tiles
 * @param {string} theme - Tileset theme (e.g., "stone dungeon")
 * @param {Object} options
 * @param {string[]} options.include - Tile types to generate
 * @param {string} options.tileSize - Tile dimensions
 * @param {string} options.style - Art style
 * @param {string} options.outputDir - Output directory
 * @returns {Promise<Object>} Generated tile paths
 */
export async function generateTileset(theme, options = {})
```

### Multi-Turn Chat for Consistency

Use chat session to maintain style:
1. First message establishes theme, colors, style
2. Subsequent messages generate each tile with context

```javascript
const chat = ai.chats.create({
  model: IMAGE_GEN_MODEL,
  config: { responseModalities: ['TEXT', 'IMAGE'] }
});

// Establish theme
await chat.sendMessage(`I'm creating a "${theme}" tileset in ${style} style.
Establish these consistent elements:
- Color palette (3-5 main colors)
- Lighting direction (top-left)
- Level of detail
- Texture style
Confirm and describe the palette you'll use.`);

// Generate each tile
for (const tileType of tilesToGenerate) {
  const result = await chat.sendMessage(buildTilePrompt(...));
  // Save tile
}
```

### CLI Command

```javascript
program
  .command('tileset <theme>')
  .description('Generate a coordinated tileset')
  .option('--include <types>', 'Tile types (comma-separated)', 'floor,walls,corners')
  .option('--size <WxH>', 'Tile dimensions', '64x32')
  .option('--style <style>', 'Art style', 'isometric pixel art')
  .option('-o, --output <dir>', 'Output directory', 'tileset/')
  .option('-v, --verbose', 'Verbose output')
  .action(async (theme, options) => {
    // Parse include types
    const include = options.include.split(',').map(s => s.trim());
    // Implementation
  });
```

### Output Structure

```
tileset-name/
├── metadata.json
├── floor-base.png
├── wall-left.png
├── wall-right.png
├── corner-nw.png
├── corner-ne.png
├── corner-sw.png
└── corner-se.png
```

### metadata.json

```json
{
  "name": "stone-dungeon",
  "theme": "stone dungeon",
  "style": "isometric pixel art",
  "tileSize": { "width": 64, "height": 32 },
  "generated": "2025-12-05T...",
  "tiles": [
    { "name": "floor-base", "type": "floor", "file": "floor-base.png" },
    { "name": "wall-left", "type": "wall-left", "file": "wall-left.png" }
  ]
}
```

---

## Tile Type Expansion

When `--include walls` is specified, expand to:
- `wall-left`
- `wall-right`

When `--include corners` is specified, expand to:
- `corner-nw`
- `corner-ne`
- `corner-sw`
- `corner-se`

---

## Testing

### Phase 1 Tests
```bash
# Basic floor tile
node src/index.js tile "grass" --type floor -o test/grass.png

# Wall tile
node src/index.js tile "stone bricks" --type wall-left -o test/wall.png

# Custom size
node src/index.js tile "wood planks" --type floor --size 128x64 -o test/wood.png

# Verify tile command exists
node src/index.js tile --help
```

### Phase 2 Tests
```bash
# Basic tileset
node src/index.js tileset "stone dungeon" -o test/dungeon/

# With specific includes
node src/index.js tileset "grassy meadow" --include floor -o test/meadow/

# Verify output structure
ls test/dungeon/
cat test/dungeon/metadata.json
```

---

## Success Criteria

### Phase 1
- [ ] `tile` command generates single tiles
- [ ] `--type` parameter works (floor, wall-left, wall-right)
- [ ] `--size` parameter controls dimensions
- [ ] Tiles have transparent background
- [ ] Prompts include seamless instructions

### Phase 2
- [ ] `tileset` command generates coordinated sets
- [ ] Multi-turn chat maintains style consistency
- [ ] metadata.json generated with tileset info
- [ ] All included tile types generated
