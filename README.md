# sprite2gif

**GPU Cats Asset Factory** - Convert sprite sheets to animated GIF/APNG with AI background removal, or generate new sprite sheets and game assets from AI.

[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## Features

- **Process Sprite Sheets** - Extract frames, AI background removal, quality control, encode as APNG/GIF
- **Generate Animations** - Create sprite sheets from text descriptions using Gemini AI
- **Generate Game Assets** - Static assets, tiles, tilesets, and complete rooms with Tiled export
- **Style Consistency** - Reference image support and project-wide style management
- **Autonomous QC** - Multi-layer anomaly detection with auto-fix capabilities

## Installation

```bash
git clone https://github.com/iangogentic/sprite2gif.git
cd sprite2gif
npm install
```

### Environment Setup

Create a `.env` file:
```
GEMINI_API_KEY=your-gemini-api-key
```

## Quick Start

### Process an Existing Sprite Sheet
```bash
node src/index.js sprite.png -r 4 -c 2 -o animation.apng --auto-fix
```

### Generate an Animation from AI
```bash
node src/index.js generate "pixel cat idle animation" --reference cat.png -o cat-idle.apng
```

### Generate a Complete Room
```bash
node src/index.js room "wooden office" -o room/
```

---

## Commands

### 1. Process Sprite Sheet (Default)

Convert an existing sprite sheet to animated APNG or GIF with AI background removal.

```bash
node src/index.js <input> [options]
```

| Option | Default | Description |
|--------|---------|-------------|
| `-r, --rows <n>` | required | Rows in sprite sheet |
| `-c, --cols <n>` | required | Columns in sprite sheet |
| `-o, --output <path>` | `output.apng` | Output file path |
| `-f, --format <type>` | `apng` | Format: `apng` or `gif` |
| `-d, --delay <ms>` | `100` | Frame delay in milliseconds |
| `-l, --loop <count>` | `0` | Loop count (0 = infinite) |
| `--auto-fix` | - | Enable autonomous quality control |
| `--no-process` | - | Skip background removal |
| `--debug-frames <dir>` | - | Save debug frames |
| `-v, --verbose` | - | Verbose output |

**Example:**
```bash
node src/index.js duck.png -r 4 -c 2 -o duck.apng --auto-fix -v
```

---

### 2. Generate Animation

Generate a sprite sheet animation from a text description.

```bash
node src/index.js generate <description> [options]
```

| Option | Default | Description |
|--------|---------|-------------|
| `--reference <image>` | - | Reference image for character consistency |
| `--style <style>` | `isometric pixel art` | Art style |
| `-r, --rows <n>` | `2` | Sprite sheet rows |
| `-c, --cols <n>` | `3` | Sprite sheet columns |
| `--animation-set` | - | Generate full set (idle, walk, typing, thinking) |
| `-o, --output <path>` | `generated.apng` | Output path |
| `--auto-fix` | - | Enable quality control |
| `--no-project` | - | Skip project style references |

**Examples:**
```bash
# Single animation with reference
node src/index.js generate "cat walking left" --reference cat.png -r 2 -c 4 -o cat-walk.apng

# Full animation set
node src/index.js generate "robot" --animation-set --reference robot.png -o ./robot/
```

---

### 3. Generate Static Asset

Generate a single static image (not animated).

```bash
node src/index.js static <description> [options]
```

| Option | Default | Description |
|--------|---------|-------------|
| `--reference <image>` | - | Reference image for style |
| `--style <style>` | `isometric pixel art` | Art style |
| `-o, --output <path>` | `static-asset.png` | Output path |

**Example:**
```bash
node src/index.js static "wooden desk with computer" --reference furniture.png -o desk.png
```

---

### 4. Generate Tile

Generate a single isometric tile.

```bash
node src/index.js tile <description> [options]
```

| Option | Default | Description |
|--------|---------|-------------|
| `--type <type>` | `floor` | Tile type (see below) |
| `--size <WxH>` | `64x32` | Tile dimensions |
| `--reference <image>` | - | Reference image |
| `-o, --output <path>` | `tile.png` | Output path |

**Tile Types:**
- `floor` - Diamond-shaped floor (64x32)
- `wall-n`, `wall-s`, `wall-e`, `wall-w` - Directional walls (64x64)
- `corner-nw`, `corner-ne`, `corner-sw`, `corner-se` - Corner pieces (64x64)

**Example:**
```bash
node src/index.js tile "grass floor" --type floor -o grass.png
```

---

### 5. Generate Tileset

Generate a coordinated set of tiles with consistent style.

```bash
node src/index.js tileset <theme> [options]
```

| Option | Default | Description |
|--------|---------|-------------|
| `--include <types>` | `floor,walls,corners` | Tile types to generate |
| `--size <WxH>` | `64x32` | Tile dimensions |
| `--reference <image>` | - | Reference image |
| `-o, --output <dir>` | `tileset/` | Output directory |

**Output:**
```
tileset/
├── metadata.json
├── floor.png
├── wall_left.png
├── wall_right.png
├── corner_nw.png
├── corner_ne.png
├── corner_sw.png
└── corner_se.png
```

---

### 6. Generate Room

Generate a complete room with tiles and Tiled editor export.

```bash
node src/index.js room <theme> [options]
```

| Option | Default | Description |
|--------|---------|-------------|
| `--layout <name>` | `office-small` | Layout: `office-small`, `office-large`, `hallway`, `procedural` |
| `--width <n>` | `6` | Room width (for procedural) |
| `--height <n>` | `5` | Room height (for procedural) |
| `--props <list>` | - | Props to generate (comma-separated) |
| `--legacy` | - | Use legacy single-tile generation |
| `--qc` | - | Enable quality control |
| `--auto-fix` | - | Auto-regenerate failing tiles |
| `-o, --output <dir>` | `room/` | Output directory |

**Output:**
```
room/
├── room.json        # Tiled map file
├── tileset.json     # Tiled tileset
├── atlas.png        # Tile spritesheet
├── tiles/           # Individual tile images
├── props/           # Prop images (if any)
├── preview.html     # Interactive preview
├── preview.png      # Static preview
└── metadata.json    # Generation info
```

**Generation Modes:**
- **Tile Sheet (default)** - All tiles generated in ONE AI call for guaranteed style consistency
- **Legacy (`--legacy`)** - Each tile generated separately

**Examples:**
```bash
# Default tile sheet generation (recommended)
node src/index.js room "wooden office" -o office/

# With quality control
node src/index.js room "stone dungeon" --qc --auto-fix -v

# Custom size procedural room
node src/index.js room "grassy meadow" --layout procedural --width 10 --height 8

# Legacy mode (separate tile generation)
node src/index.js room "wooden office" --legacy
```

---

### 7. Project Management

Manage project-wide style references for consistent generation.

```bash
# Initialize project
node src/index.js init [project-name]

# Add style reference
node src/index.js add-style <image> --name "ref-name" --description "description"

# List references
node src/index.js list-styles

# Remove reference
node src/index.js remove-style <name>
```

**Project Structure:**
```
my-project/
├── .sprite2gif/
│   ├── config.json
│   └── style-references/
│       ├── character.png
│       └── palette.png
```

Style references are automatically injected into all `generate`, `static`, `tile`, `tileset`, and `room` commands. Use `--no-project` to disable.

---

## Output Formats

### APNG (Recommended)
- Full 8-bit alpha transparency
- No fringe artifacts
- Supported in all modern browsers

### GIF
- 1-bit binary transparency
- May have fringe artifacts on complex edges
- Universal compatibility

---

## Quality Control System

The `--auto-fix` flag enables multi-layer anomaly detection:

1. **Color Histogram Analysis** - Detects color washout
2. **Alpha Channel Analysis** - IQR-based transparency hole detection
3. **SSIM Structural Check** - Catches structural damage
4. **Pixelmatch Outlier Detection** - Flags major pixel changes

Bad frames are automatically replaced with nearest good neighbors, and animation wobble is corrected via bottom-center anchoring.

---

## Technical Details

### AI Model
- **Gemini 3 Pro Image Preview** (`gemini-3-pro-image-preview`)
- Supports up to 14 reference images
- 4K output capability

### Isometric Geometry
- 2:1 pixel ratio (26.57° angle)
- Light source from top-left
- Floors: 64x32px, Walls/Corners: 64x64px

### Dependencies
- `@google/genai` - Gemini AI integration
- `@imgly/background-removal-node` - AI background removal
- `sharp` - Image processing
- `puppeteer` - Frame detection with OpenCV.js
- `commander` - CLI framework

---

## Examples

### Full Workflow: Character Animation
```bash
# 1. Initialize project
node src/index.js init my-game

# 2. Add character reference
node src/index.js add-style character.png --name "hero"

# 3. Generate animations
node src/index.js generate "hero idle breathing" -r 2 -c 3 -o hero-idle.apng
node src/index.js generate "hero walking right" -r 2 -c 4 -o hero-walk.apng

# 4. Generate full animation set
node src/index.js generate "hero" --animation-set -o ./hero-animations/
```

### Full Workflow: Game Environment
```bash
# Generate room with tiles
node src/index.js room "cozy tavern" --layout office-large --qc -o tavern/

# Generate additional props
node src/index.js static "wooden barrel" -o tavern/props/barrel.png
node src/index.js static "tavern sign" -o tavern/props/sign.png
```

### Process Existing Sprite Sheet
```bash
# With full quality control and debugging
node src/index.js spritesheet.png -r 4 -c 4 -o output.apng \
  --auto-fix --debug-frames ./debug -v
```

---

## License

MIT

---

## Contributing

Contributions welcome! Please read the contributing guidelines first.

## Acknowledgments

Built for the GPU Cats Visual Agent IDE project.
