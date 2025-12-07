# Task: Fix Image Consistency in generator.js

## Problem Statement

The current `generateFrames()` function in `/Users/iangreenberg/Desktop/animationv1/src/generator.js` produces inconsistent character designs across animation frames because it does NOT pass the generated images back into subsequent turns of the multi-turn chat.

When a user chats in Google AI Studio and uploads images, the model sees both:
1. The previous image(s) as actual image data
2. The text prompt

But our current implementation only sends text prompts after the first frame:

```javascript
// Current broken code (lines 154-166):
for (let i = 2; i <= frames; i++) {
  const framePrompt = `Now generate frame ${i} of ${frames}.
Keep the exact same character design and style.  // Just text - no image!
...`;
  response = await chat.sendMessage({ message: framePrompt });  // Text only!
}
```

## Root Cause

The `@google/genai` chat API **does** maintain conversation history, but for image generation tasks, we need to explicitly pass the previously generated image back to ensure visual consistency. The model's "memory" of what it generated is not reliable enough for frame-to-frame consistency.

## Solution

Modify `generateFrames()` to:
1. Extract the generated image from each response
2. Pass that image as `inlineData` in the next turn's message
3. Use the proper message format with both image and text parts

## API Reference

The correct format for sending images with the `@google/genai` SDK:

```javascript
const response = await chat.sendMessage({
  message: [
    {
      inlineData: {
        mimeType: 'image/png',
        data: imageBuffer.toString('base64')
      }
    },
    {
      text: 'Your prompt here...'
    }
  ]
});
```

## Files to Modify

- `/Users/iangreenberg/Desktop/animationv1/src/generator.js`

## Requirements

1. Modify `generateFrames()` function to pass the previous frame's image in each subsequent turn
2. Keep `generateSpriteSheet()` function unchanged (it generates all frames in one image)
3. Update the prompts to reference "the attached image" as the previous frame
4. Ensure proper error handling if image extraction fails
5. Maintain backward compatibility with existing CLI options
6. Do NOT modify any other files

## Expected Behavior After Fix

When running:
```bash
node src/index.js generate "a samurai walking" -n 6 --method frames
```

Each frame should show the EXACT same character with only pose changes, because the model will see the actual previous frame image.

## Testing

After implementation, the developer should:
1. Run a test generation with `--method frames`
2. Visually verify the frames have consistent character design
3. Ensure no regressions in the `--method sheet` mode (default)

## Code Location

The `generateFrames()` function starts at line 109 of generator.js.

The `extractImage()` helper at line 185 already extracts image buffers from responses - reuse this.
