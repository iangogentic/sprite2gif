# Task: Static Asset Mode

> **Status:** PLANNED
> **Priority:** High
> **Depends On:** None

---

## Goal

Add the ability to generate single-frame static assets (desks, chairs, props) in addition to animated sprite sheets.

---

## Current State

The system only supports animated sprite sheet generation:
- `generateSpriteSheet()` - Creates multi-frame grid
- `createAnimationSet()` - Creates idle/walk/typing/thinking sets

There's no way to generate a single static image for props/furniture.

---

## Implementation

### 1. Add `generateStaticAsset()` to generator.js

```javascript
/**
 * Generate a single static asset image
 * @param {string} description - What to generate
 * @param {Object} options - Generation options
 * @param {string} options.referenceImage - Path to reference image
 * @param {string} options.style - Art style (default: "isometric pixel art")
 * @param {string} options.outputPath - Where to save result
 * @returns {Promise<string>} - Path to generated image
 */
async function generateStaticAsset(description, options = {}) {
  const {
    referenceImage,
    style = 'isometric pixel art',
    outputPath = 'static-asset.png'
  } = options;

  const contents = [];

  // Add reference image first (if provided)
  if (referenceImage) {
    const imageBuffer = await fs.readFile(referenceImage);
    contents.push({
      inlineData: {
        mimeType: getMimeType(referenceImage),
        data: imageBuffer.toString('base64')
      }
    });
  }

  // Add prompt
  contents.push({
    text: buildStaticAssetPrompt(description, style)
  });

  const result = await ai.models.generateContent({
    model: IMAGE_GEN_MODEL,
    contents: [{ role: 'user', parts: contents }],
    generationConfig: {
      responseModalities: ['image', 'text'],
      responseMimeType: 'image/png'
    }
  });

  // Extract and save image
  const imagePart = result.response.candidates[0]
    .content.parts.find(p => p.inlineData?.mimeType?.startsWith('image/'));

  if (!imagePart) {
    throw new Error('No image generated');
  }

  const imageBuffer = Buffer.from(imagePart.inlineData.data, 'base64');
  await fs.writeFile(outputPath, imageBuffer);

  return outputPath;
}
```

### 2. Add Prompt Builder

```javascript
function buildStaticAssetPrompt(description, style) {
  return `Generate a SINGLE STATIC ${style} asset:

SUBJECT: ${description}

CRITICAL REQUIREMENTS:
1. ONE image only - NOT a sprite sheet, NOT multiple frames
2. Transparent background (alpha channel)
3. Consistent with any reference images provided
4. Clean pixel edges, no anti-aliasing blur
5. Centered composition with even padding on all sides
6. High detail appropriate for the style

COMPOSITION:
- Asset should fill 70-80% of the frame
- Even padding on all sides
- Consistent lighting from top-left

OUTPUT FORMAT:
- Single PNG image
- Transparent background
- Resolution: 512x512 or larger`;
}
```

### 3. Add CLI Command

In `index.js`, add the `static` subcommand:

```javascript
program
  .command('static <description>')
  .description('Generate a single static asset')
  .option('--reference <image>', 'Reference image for style consistency')
  .option('--style <style>', 'Art style', 'isometric pixel art')
  .option('-o, --output <path>', 'Output path', 'static-asset.png')
  .option('--count <n>', 'Generate multiple assets', '1')
  .option('--variations', 'Generate style variations')
  .option('-v, --verbose', 'Verbose output')
  .action(async (description, options) => {
    await generateStaticWorkflow(description, options);
  });
```

### 4. Batch Generation Support

```javascript
async function generateStaticWorkflow(description, options) {
  const count = parseInt(options.count) || 1;
  const results = [];

  for (let i = 0; i < count; i++) {
    const suffix = count > 1 ? `-${i + 1}` : '';
    const outputPath = options.output.replace(/\.png$/, `${suffix}.png`);

    const variedDescription = options.variations
      ? `${description} (variation ${i + 1})`
      : description;

    console.log(`Generating ${i + 1}/${count}: ${variedDescription}`);

    const result = await generateStaticAsset(variedDescription, {
      referenceImage: options.reference,
      style: options.style,
      outputPath
    });

    results.push(result);
  }

  return results;
}
```

---

## CLI Examples

```bash
# Basic static asset
node src/index.js static "wooden desk with dual monitors" -o desk.png

# With reference for style consistency
node src/index.js static "office chair" --reference office-style.png -o chair.png

# Generate 3 variations
node src/index.js static "coffee mug" --count 3 --variations -o mugs/mug.png

# Custom style
node src/index.js static "server rack" --style "16-bit pixel art" -o server.png
```

---

## Testing

### Test 1: Basic Generation
```bash
node src/index.js static "wooden desk" -o test/desk.png
# Verify: Single PNG, transparent background, centered
```

### Test 2: Reference Image
```bash
node src/index.js static "matching chair" --reference test/desk.png -o test/chair.png
# Verify: Style matches desk
```

### Test 3: Batch Generation
```bash
node src/index.js static "plant" --count 3 -o test/plants/plant.png
# Verify: plant-1.png, plant-2.png, plant-3.png created
```

---

## Success Criteria

- [ ] `sprite2gif static <description>` generates single image
- [ ] Reference image support works
- [ ] Batch generation with `--count` works
- [ ] `--variations` flag generates distinct variations
- [ ] Output has transparent background
- [ ] Style is consistent with references
