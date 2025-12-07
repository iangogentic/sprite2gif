# GPU Cats Asset Factory (sprite2gif)

Convert sprite sheets to animated GIF/APNG with AI background removal, or generate new sprite sheets from AI.

**Version:** 3.0.0

---

## Purpose
The **GPU Cats Asset Factory** generates and processes animated assets for the GPU Cats Visual Agent IDE project. It provides two main capabilities:

1. **Process existing sprite sheets** - Extract frames, remove backgrounds, fix quality issues, and encode as APNG/GIF
2. **Generate from AI** - Create new sprite sheets using Google's Gemini AI with reference image support for character consistency

---

## Current Status: FULLY AUTONOMOUS
APNG output works with full alpha transparency. The `--auto-fix` flag enables autonomous quality control with **multi-layer anomaly detection**:

1. **Color Histogram Analysis** - Primary detector for color washout (green head - pale green)
2. **Alpha Channel Analysis** - Detects transparency holes using IQR-based outlier detection
3. **Structural Similarity (SSIM)** - Catches structural damage with 3x IQR bounds
4. **Pixelmatch Outlier Detection** - Catches major unexpected changes

**No human intervention required.**

---

## The Core Problem & Solution

### Problem: AI Background Removal is Non-Deterministic
The `@imgly/background-removal-node` library occasionally misclassifies foreground pixels as background, especially:
- Green colors (confuses with green screen)
- Similar-colored adjacent regions
- Varies randomly between runs

**Example**: In the duck sprite sheet, frame 7 had the green mallard head become washed out (pale green) while other frames were fine.

### Why Pixelmatch-Only Detection FAILS
Original pixelmatch detection showed ~22% diff for bad frame 7 - same as normal animation frames!
This is because color washout doesn't change pixel positions significantly.

### Solution: Multi-Layer Anomaly Detection
```
1. Extract frames from sprite sheet
2. AI remove background from each frame
3. DETECT bad frames via:
   - Color histogram (catches washout - frame 7 had 26% of median green pixels)
   - Alpha analysis (catches transparency holes via IQR outlier detection)
   - SSIM structural check (catches damage with 3x IQR bounds)
   - Pixelmatch outlier (catches major changes)
4. REPLACE bad frames with nearest good neighbor
5. STABILIZE animation (bottom-center anchor alignment)
6. OUTPUT as APNG (full alpha support)
```

---

## What Works
- Frame extraction via Sharp
- AI bg removal: `@imgly/background-removal-node` (needs Blob input, not Buffer)
- AI generation via `gemini-3-pro-image-preview` with reference image support (up to 14 reference images, 4K output, aspect ratio control)
- **APNG output** - full 8-bit alpha, no fringe artifacts
- GIF output (fallback) - 1-bit transparency, has fringe issues

## All Issues Now Automated
| Issue | Detection Method | Resolution |
|-------|-----------------|------------|
| Color washout (e.g., green head - pale) | Color histogram: flag if <35% of median color pixels | Replace with nearest good frame |
| Transparency holes | Alpha analysis with IQR outlier detection (2.5x IQR) | Replace with nearest good frame |
| Structural damage | SSIM with 3x IQR bounds, must affect BOTH neighbors | Replace with nearest good frame |
| Major pixel changes | Pixelmatch outlier: >15% diff vs median | Replace with nearest good frame |
| Animation wobble | Always applied | Bottom-center anchor alignment |

---

## Detection Algorithm Details

### Color Histogram Analysis (Primary - catches color washout)
```javascript
// Count pixels in color categories (green, brown, dark)
// Flag frames where any category has < 35% of median count
const greenRatio = frame.colors.darkGreen / medians.darkGreen;
if (greenRatio < 0.35) {
  flagBadFrame(frame.index, 'color_loss');
}
// Frame 7 in testing had greenRatio = 0.26 (26% of median) - caught!
```

### Alpha Channel Analysis (IQR-based)
```javascript
// Calculate IQR for opacity across all frames
const opacityQ1 = sortedOpacity[Math.floor(length * 0.25)];
const opacityQ3 = sortedOpacity[Math.floor(length * 0.75)];
const opacityIQR = opacityQ3 - opacityQ1;
const lowerBound = opacityQ1 - 2.5 * opacityIQR;
// Only flag TRUE outliers, not normal animation variance
```

### SSIM Structural Check (Very Strict)
```javascript
// Use 3x IQR bounds - only catches EXTREME outliers
const ssimOutlierThreshold = ssimQ1 - 3.0 * ssimIQR;
// Both neighbors must show low SSIM to flag (not just one)
const bothLow = ssimToPrev < threshold && ssimToNext < threshold;
```

### Alternative BG Removal (if @imgly keeps failing)
- **rembg** (Python): `pip install rembg` - more consistent, less green-confusion
- **Flood fill + edge detection**: For solid backgrounds only
- **Chroma key**: If background is pure green/blue

---

## Architecture
```
src/
├── index.js          # CLI entry point (v3.0.0 - two main commands)
├── generator.js      # AI sprite sheet generation (gemini-3-pro-image-preview + reference images)
├── detector.js       # Frame detection via Puppeteer+OpenCV
├── extractor.js      # Sharp frame extraction
├── processor.js      # AI bg removal (line ~31)
├── autofix.js        # AUTONOMOUS quality control (~700 lines)
│   ├── autoFix()             - Main pipeline entry point
│   ├── detectBadFrames()     - Multi-layer anomaly detection:
│   │   ├── Color histogram analysis
│   │   ├── Alpha channel analysis (IQR-based)
│   │   ├── SSIM structural check (3x IQR bounds)
│   │   └── Pixelmatch outlier detection
│   ├── analyzePixels()       - Color/alpha statistics
│   ├── calculateSimplifiedSSIM() - Structural similarity
│   ├── replaceBadFrames()    - Swap with good neighbors
│   ├── stabilizeFrames()     - Bottom-center anchoring
│   ├── findContentBounds()   - Bounding box detection
│   ├── verifyFrames()        - Final quality check
│   └── saveDebugFrames()     - Debug output helper
├── apngEncoder.js    # APNG output (manual chunk assembly)
├── gifEncoder.js     # GIF output + artifact cleanup
├── analyzer.js       # Quality checks
└── opencv-processor.html
```

**Source Files:** 10 files (~2,930 lines after refactor)

---

## Critical Code & Quirks

### @imgly Blob Requirement
```javascript
// WRONG - will fail silently or produce bad output
const result = await removeBackground(buffer);

// CORRECT - must wrap as Blob
const blob = new Blob([buffer], { type: 'image/png' });
const result = await removeBackground(blob);
const outputBuffer = Buffer.from(await result.arrayBuffer());
```

### APNG Requires RGBA Frames
```javascript
// If frames are indexed PNG, APNG will show broken
// Convert to RGBA first:
await sharp(framePath)
  .png({ palette: false })  // Force RGBA, not indexed
  .toFile(outputPath);
```

### APNG Chunk Structure
```
PNG Signature (8 bytes)
IHDR (image header)
acTL (animation control - frame count, loop count)
For each frame:
  fcTL (frame control - dimensions, delay, dispose)
  IDAT (frame 0) or fdAT (frames 1+)
IEND
```

---

## CLI Usage

### Command 1: Process Existing Sprite Sheet
```bash
cd /Users/iangreenberg/Desktop/animationv1

# FULLY AUTONOMOUS (recommended)
node src/index.js ~/Downloads/duckspritesheet.jpeg -r 4 -c 2 -o test/duck.apng --auto-fix

# With debug frames for inspection
node src/index.js ~/Downloads/duckspritesheet.jpeg -r 4 -c 2 -o test/duck.apng --auto-fix --debug-frames test/debug

# Basic APNG (no auto-fix)
node src/index.js ~/Downloads/duckspritesheet.jpeg -r 4 -c 2 -o test/duck.apng -d 120

# GIF output (has fringe issues, not recommended)
node src/index.js ~/Downloads/duckspritesheet.jpeg -r 4 -c 2 -o test/duck.gif -f gif
```

### Command 2: Generate From AI
```bash
# Single animation with reference image
node src/index.js generate "pixel cat idle animation" --reference cat.png -r 2 -c 3 -o output.apng

# Full animation set (idle, walk, typing, thinking)
node src/index.js generate "cat" --animation-set --reference cat.png -o ./output/

# Generate with custom style
node src/index.js generate "robot walking" --style "16-bit pixel art" -r 2 -c 4 -o robot-walk.apng
```

### CLI Options (Process)
| Option | Description |
|--------|-------------|
| `-r, --rows <n>` | Number of rows in sprite sheet (required) |
| `-c, --cols <n>` | Number of columns in sprite sheet (required) |
| `-o, --output <path>` | Output file path |
| `-d, --delay <ms>` | Frame delay in milliseconds (default: 100) |
| `-f, --format <type>` | Output format: `apng` (default) or `gif` |
| `-l, --loop <count>` | Loop count (0 = infinite, default) |
| `--no-loop` | Disable looping |
| `--auto-fix` | **Enable autonomous quality control** |
| `--no-process` | Skip background removal and alignment |
| `--debug-frames <dir>` | Save intermediate frames for debugging |
| `-p, --preview` | Preview detected frames without generating |
| `--open` | Open result when done |
| `-v, --verbose` | Verbose output |

### CLI Options (Generate)
| Option | Description |
|--------|-------------|
| `--reference <image>` | Reference image for character consistency (recommended) |
| `--style <style>` | Art style (default: "isometric pixel art") |
| `--animation-set` | Generate full set (idle, walk, typing, thinking) |
| `-r, --rows <n>` | Rows in generated grid (default: 2) |
| `-c, --cols <n>` | Columns in generated grid (default: 3) |
| `-o, --output <path>` | Output path |
| `-d, --delay <ms>` | Frame delay in milliseconds (default: 100) |
| `-f, --format <type>` | Output format: `apng` (default) or `gif` |
| `-l, --loop <count>` | Loop count (0 = infinite, default) |
| `--auto-fix` | Enable autonomous quality control |
| `--debug-frames <dir>` | Save intermediate frames for debugging |
| `--open` | Open result when done |
| `-v, --verbose` | Verbose output |
| `--no-project` | Skip auto-injection of project style references |

### Command 3: Static Asset Generation
```bash
# Generate a single static image (not animated)
node src/index.js static "wooden desk with computer" -o desk.png

# With reference image for style consistency
node src/index.js static "office chair" --reference furniture-style.png -o chair.png

# With custom style
node src/index.js static "coffee mug" --style "16-bit pixel art" -o mug.png
```

### CLI Options (Static)
| Option | Description |
|--------|-------------|
| `--reference <image>` | Reference image for style consistency |
| `--style <style>` | Art style (default: "isometric pixel art") |
| `-o, --output <path>` | Output path (default: "static-asset.png") |
| `--no-project` | Skip auto-injection of project style references |
| `-v, --verbose` | Verbose output |

### Command 4: Project Management
```bash
# Initialize a project (creates .sprite2gif/ folder)
node src/index.js init my-project

# Add style references (auto-injected into all generations)
node src/index.js add-style cat.png --name "main-cat" --description "Main character"

# List all style references
node src/index.js list-styles

# Remove a style reference
node src/index.js remove-style main-cat
```

### Project System
When you initialize a project with `init`, a `.sprite2gif/` folder is created:
```
my-project/
├── .sprite2gif/
│   ├── config.json
│   └── style-references/
│       └── main-cat.png
```

All `generate` and `static` commands automatically inject these style references into the AI generation, ensuring visual consistency across all assets. Use `--no-project` to skip this auto-injection.

### Command 5: Single Tile Generation
```bash
# Generate a floor tile
node src/index.js tile "grass floor" --type floor -o grass.png

# Generate a wall tile
node src/index.js tile "stone bricks" --type wall-left -o wall-left.png

# Custom size tile
node src/index.js tile "wooden planks" --type floor --size 128x64 -o wood.png

# With reference image
node src/index.js tile "cobblestone" --reference style-ref.png -o cobble.png
```

### CLI Options (Tile)
| Option | Description |
|--------|-------------|
| `--type <type>` | Tile type: floor, wall-left, wall-right, corner-* (default: floor) |
| `--size <WxH>` | Tile dimensions (default: "64x32") |
| `--style <style>` | Art style (default: "isometric pixel art") |
| `--no-seamless` | Disable seamless edge requirements |
| `--reference <image>` | Reference image for style consistency |
| `-o, --output <path>` | Output file path (default: "tile.png") |
| `--no-project` | Skip auto-injection of project style references |
| `-v, --verbose` | Verbose output |

### Command 6: Tileset Generation
```bash
# Generate a coordinated tileset (floor + walls + corners)
node src/index.js tileset "stone dungeon" -o dungeon/

# Generate specific tile types
node src/index.js tileset "grassy meadow" --include floor,walls -o meadow/

# With reference image for style
node src/index.js tileset "office interior" --reference office-style.png -o office/
```

### CLI Options (Tileset)
| Option | Description |
|--------|-------------|
| `--include <types>` | Tile types: floor, walls, corners (comma-separated, default: all) |
| `--size <WxH>` | Tile dimensions (default: "64x32") |
| `--style <style>` | Art style (default: "isometric pixel art") |
| `--reference <image>` | Reference image for style consistency |
| `-o, --output <dir>` | Output directory (default: "tileset/") |
| `--no-project` | Skip auto-injection of project style references |
| `-v, --verbose` | Verbose output |

### Tileset Output Structure
```
tileset-name/
├── metadata.json      # Tileset configuration
├── floor.png          # Floor tile
├── wall_left.png      # Left-facing wall
├── wall_right.png     # Right-facing wall
├── corner_nw.png      # Northwest corner
├── corner_ne.png      # Northeast corner
├── corner_sw.png      # Southwest corner
└── corner_se.png      # Southeast corner
```

### Tile Types Reference
| Type | Description |
|------|-------------|
| `floor` | Isometric floor tile (diamond shape, 2:1 ratio) |
| `wall-left` | Left-facing wall (recedes right) |
| `wall-right` | Right-facing wall (recedes left) |
| `corner-nw` | Northwest outer corner |
| `corner-ne` | Northeast outer corner |
| `corner-sw` | Southwest outer corner |
| `corner-se` | Southeast outer corner |

---

## Testing & Verification

### Visual Inspection (Puppeteer)
```javascript
const browser = await puppeteer.launch({ headless: false });
const page = await browser.newPage();
await page.goto('file:///path/to/test/frames/inspect.html');
// Look at checkerboard background - transparent areas visible
```

### Verify in Chrome
APNGs render natively in Chrome. Open the .apng file directly to see animation.

---

## Known Working Output
- **`test/duck-stable2.apng`** - Final working animation
  - Bad frames 4 and 7 replaced with frames 3 and 6
  - Bottom-center stabilization applied
  - Full alpha transparency, no artifacts

---

## Dependencies
```json
{
  "@anthropic-ai/sdk": "^0.71.0",
  "@google/genai": "^1.30.0",
  "@imgly/background-removal-node": "^1.4.5",
  "apng-js": "^1.1.5",
  "commander": "^12.1.0",
  "gif-encoder-2": "^1.0.5",
  "pixelmatch": "^7.1.0",
  "puppeteer": "^23.0.0",
  "sharp": "^0.33.5"
}
```

---

## Task Management

- **CURRENT_PROJECT.md** - Active work tracker
- **tasks/** - Individual task specs
- **docs/completed/** - Archived completed work

See `CURRENT_PROJECT.md` for current work and `tasks/` for detailed implementation specs.
