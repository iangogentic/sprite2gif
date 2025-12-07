#!/usr/bin/env node

import 'dotenv/config';

import { program } from 'commander';
import { detectFrames } from './detector.js';
import { extractFrames } from './extractor.js';
import { createGif } from './gifEncoder.js';
import { createApng } from './apngEncoder.js';
import { processFrames } from './processor.js';
import { analyzeGifQuality } from './analyzer.js';
import { autoFix, saveDebugFrames } from './autofix.js';
import {
  generateSpriteSheet,
  createAnimationSet,
  generateStaticAsset,
  generateTile,
  generateTileset,
  generateRoom,           // Legacy: Single Tile Generation
  generateRoomWithSheet   // Default: Tile Sheet Generation (style-consistent)
} from './generator.js';
import { saveRoomPreview } from './preview.js';
import { roomQC } from './roomQC.js';
import {
  initProject,
  addStyleReference,
  removeStyleReference,
  listStyleReferences,
  loadProjectConfig,
  getStyleReferenceBuffers
} from './project.js';
import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';

/**
 * GPU Cats Asset Factory CLI
 *
 * Two main commands:
 * 1. Process existing sprite sheet: node src/index.js <input.png> -r 4 -c 2 -o output.apng
 * 2. Generate from AI: node src/index.js generate <description> --reference ref.png -r 2 -c 3 -o output.apng
 */

program
  .name('sprite2gif')
  .description('GPU Cats Asset Factory - Convert sprite sheets to animated GIFs/APNGs or generate from AI')
  .version('3.0.0');

// ============================================================================
// Command 1: Process existing sprite sheet
// ============================================================================
program
  .argument('[input]', 'Input sprite sheet image (PNG recommended)')
  .option('-o, --output <path>', 'Output path (default: output.apng)')
  .option('-f, --format <type>', 'Output format: apng (default) or gif', 'apng')
  .option('-r, --rows <number>', 'Number of rows in sprite sheet')
  .option('-c, --cols <number>', 'Number of columns in sprite sheet')
  .option('-d, --delay <ms>', 'Delay between frames in ms', '100')
  .option('-l, --loop <count>', 'Loop count (0 = infinite)', '0')
  .option('--no-loop', 'Disable looping')
  .option('-p, --preview', 'Preview detected frames without generating animation')
  .option('--no-process', 'Skip automatic background removal and alignment')
  .option('--auto-fix', 'Enable autonomous quality control (detect & fix bad frames, stabilize)')
  .option('--debug-frames <dir>', 'Save intermediate frames to directory for debugging')
  .option('--open', 'Open the generated animation when done')
  .option('-v, --verbose', 'Verbose output')
  .action(async (input, options, command) => {
    // If no input and no subcommand, show help
    if (!input) {
      program.help();
      return;
    }

    await processExistingSpriteSheet(input, options);
  });

// ============================================================================
// Command 2: Generate from AI
// ============================================================================
program
  .command('generate <description>')
  .description('Generate an animation from a text description using Gemini AI')
  .option('-o, --output <path>', 'Output path (default: generated.apng)')
  .option('-f, --format <type>', 'Output format: apng (default) or gif', 'apng')
  .option('-r, --rows <number>', 'Number of rows in sprite sheet grid', '2')
  .option('-c, --cols <number>', 'Number of columns in sprite sheet grid', '3')
  .option('-d, --delay <ms>', 'Delay between frames in ms', '100')
  .option('-l, --loop <count>', 'Loop count (0 = infinite)', '0')
  .option('--reference <image>', 'Reference image for character consistency (recommended)')
  .option('--style <style>', 'Art style for generation', 'isometric pixel art')
  .option('--animation-set', 'Generate full animation set (idle, walk, typing, thinking)')
  .option('--auto-fix', 'Enable autonomous quality control')
  .option('--debug-frames <dir>', 'Save intermediate frames for debugging')
  .option('--open', 'Open the generated animation when done')
  .option('--no-project', 'Skip auto-injection of project style references')
  .option('-v, --verbose', 'Verbose output')
  .action(async (description, options) => {
    if (options.animationSet) {
      await generateAnimationSetWorkflow(options);
    } else {
      await generateSingleAnimation(description, options);
    }
  });

// ============================================================================
// Command 3: Initialize Project
// ============================================================================
program
  .command('init [name]')
  .description('Initialize a new sprite2gif project in current directory')
  .action(async (name) => {
    try {
      const projectPath = await initProject(name);
      console.log(`Initialized sprite2gif project at ${projectPath}`);
      console.log('\nNext steps:');
      console.log('  node src/index.js add-style <image>  Add a style reference');
      console.log('  node src/index.js generate "..."     Generate with auto-injected references');
    } catch (error) {
      console.error('Error:', error.message);
      process.exit(1);
    }
  });

// ============================================================================
// Command 4: Add Style Reference
// ============================================================================
program
  .command('add-style <image>')
  .description('Add a style reference image to the project')
  .option('--name <name>', 'Name for this reference (defaults to filename)')
  .option('--description <desc>', 'Description of the reference')
  .action(async (image, options) => {
    try {
      // Default name to filename without extension if not provided
      const name = options.name || path.basename(image, path.extname(image));
      const ref = await addStyleReference(image, name, options.description);
      console.log(`Added style reference: ${ref.name}`);
      console.log(`  Path: ${ref.path}`);
    } catch (error) {
      console.error('Error:', error.message);
      process.exit(1);
    }
  });

// ============================================================================
// Command 5: List Style References
// ============================================================================
program
  .command('list-styles')
  .description('List all style references in the project')
  .action(async () => {
    try {
      const refs = await listStyleReferences();
      if (refs.length === 0) {
        console.log('No style references configured.');
        console.log('Use: node src/index.js add-style <image>');
        return;
      }
      console.log('Style References:');
      for (const ref of refs) {
        console.log(`  ${ref.name}`);
        console.log(`    Path: ${ref.path}`);
        if (ref.description) {
          console.log(`    Description: ${ref.description}`);
        }
      }
    } catch (error) {
      console.error('Error:', error.message);
      process.exit(1);
    }
  });

// ============================================================================
// Command 6: Remove Style Reference
// ============================================================================
program
  .command('remove-style <name>')
  .description('Remove a style reference from the project')
  .action(async (name) => {
    try {
      await removeStyleReference(name);
      console.log(`Removed style reference: ${name}`);
    } catch (error) {
      console.error('Error:', error.message);
      process.exit(1);
    }
  });

// ============================================================================
// Command 7: Generate Static Asset
// ============================================================================
program
  .command('static <description>')
  .description('Generate a single static asset (not animated)')
  .option('--reference <image>', 'Reference image for style consistency')
  .option('--style <style>', 'Art style', 'isometric pixel art')
  .option('-o, --output <path>', 'Output path', 'static-asset.png')
  .option('--no-project', 'Skip auto-injection of project style references')
  .option('-v, --verbose', 'Verbose output')
  .action(async (description, options) => {
    try {
      console.log(`Generating static asset: ${description}`);

      // Load project references if in a project and --no-project not set
      let projectReferences = [];
      if (options.project !== false) {
        try {
          projectReferences = await getStyleReferenceBuffers();
          if (projectReferences.length > 0 && options.verbose) {
            console.log(`Auto-injecting ${projectReferences.length} project reference(s)`);
          }
        } catch (e) {
          // Not in a project, that's fine
        }
      }

      const result = await generateStaticAsset(description, {
        referenceImage: options.reference,
        projectReferences,
        style: options.style,
        outputPath: options.output,
        verbose: options.verbose
      });

      console.log(`Generated: ${result}`);

    } catch (error) {
      console.error('Error:', error.message);
      if (options.verbose) {
        console.error(error.stack);
      }
      process.exit(1);
    }
  });

// ============================================================================
// Command 8: Generate Single Tile
// ============================================================================
program
  .command('tile <description>')
  .description('Generate a seamless environment tile')
  .option('--type <type>', 'Tile type: floor, wall-left, wall-right, corner-*', 'floor')
  .option('--size <WxH>', 'Tile dimensions (width x height)', '64x32')
  .option('--style <style>', 'Art style', 'isometric pixel art')
  .option('--no-seamless', 'Disable seamless edge requirements')
  .option('--reference <image>', 'Reference image for style consistency')
  .option('-o, --output <path>', 'Output file path', 'tile.png')
  .option('--no-project', 'Skip auto-injection of project style references')
  .option('-v, --verbose', 'Verbose output')
  .action(async (description, options) => {
    try {
      console.log(`Generating tile: ${description}`);

      // Load project references if applicable
      let projectReferences = [];
      if (options.project !== false) {
        try {
          projectReferences = await getStyleReferenceBuffers();
          if (projectReferences.length > 0 && options.verbose) {
            console.log(`Auto-injecting ${projectReferences.length} project reference(s)`);
          }
        } catch (e) {
          // Not in a project, that's fine
        }
      }

      const result = await generateTile(description, {
        type: options.type,
        tileSize: options.size,
        style: options.style,
        seamless: options.seamless,
        referenceImage: options.reference,
        projectReferences,
        outputPath: options.output,
        verbose: options.verbose
      });

      console.log(`Generated: ${result}`);

    } catch (error) {
      console.error('Error:', error.message);
      if (options.verbose) {
        console.error(error.stack);
      }
      process.exit(1);
    }
  });

// ============================================================================
// Command 9: Generate Tileset
// ============================================================================
program
  .command('tileset <theme>')
  .description('Generate a coordinated set of environment tiles')
  .option('--include <types>', 'Tile types to include (comma-separated: floor,walls,corners)', 'floor,walls,corners')
  .option('--size <WxH>', 'Tile dimensions', '64x32')
  .option('--style <style>', 'Art style', 'isometric pixel art')
  .option('--reference <image>', 'Reference image for style consistency')
  .option('-o, --output <dir>', 'Output directory', 'tileset/')
  .option('--no-project', 'Skip auto-injection of project style references')
  .option('-v, --verbose', 'Verbose output')
  .action(async (theme, options) => {
    try {
      console.log(`Generating tileset: ${theme}`);

      // Parse include types
      const include = options.include.split(',').map(s => s.trim());

      // Load project references if applicable
      let projectReferences = [];
      if (options.project !== false) {
        try {
          projectReferences = await getStyleReferenceBuffers();
          if (projectReferences.length > 0 && options.verbose) {
            console.log(`Auto-injecting ${projectReferences.length} project reference(s)`);
          }
        } catch (e) {
          // Not in a project, that's fine
        }
      }

      const result = await generateTileset(theme, {
        include,
        tileSize: options.size,
        style: options.style,
        referenceImage: options.reference,
        projectReferences,
        outputDir: options.output,
        verbose: options.verbose
      });

      console.log(`\nTileset generated: ${result.outputDir}`);
      console.log(`Tiles created: ${result.tiles.length}`);
      for (const tile of result.tiles) {
        console.log(`  - ${tile.file} (${tile.type})`);
      }

    } catch (error) {
      console.error('Error:', error.message);
      if (options.verbose) {
        console.error(error.stack);
      }
      process.exit(1);
    }
  });

// ============================================================================
// Command 10: Generate Complete Room
// ============================================================================
// Two generation modes available:
//   - Tile Sheet Generation (default): Generates all tiles in ONE AI call for style consistency
//   - Legacy Single Tile Generation: Generates each tile separately (use --legacy flag)
// ============================================================================
program
  .command('room <theme>')
  .description('Generate a complete room with Tiled export (uses tile sheet generation for style consistency)')
  .option('--legacy', 'Use legacy single-tile generation instead of tile sheet generation')
  .option('--layout <name>', 'Layout template (office-small, office-large, hallway) or "procedural"', 'office-small')
  .option('--width <n>', 'Room width in tiles (for procedural layout)', '6')
  .option('--height <n>', 'Room height in tiles (for procedural layout)', '5')
  .option('--props <list>', 'Props to generate (comma-separated, e.g., "desk,chair,plant")', '')
  .option('--size <WxH>', 'Tile dimensions', '64x32')
  .option('--style <style>', 'Art style', 'isometric pixel art')
  .option('--reference <image>', 'Reference image for style consistency')
  .option('-o, --output <dir>', 'Output directory (default: room/)')
  .option('--no-project', 'Skip auto-injection of project style references')
  .option('--qc', 'Enable room quality control and preview generation')
  .option('--auto-fix', 'Automatically regenerate tiles that fail QC (implies --qc)')
  .option('--qc-threshold <n>', 'Minimum QC score to pass (0-100)', '70')
  .option('-v, --verbose', 'Verbose output')
  .action(async (theme, options, command) => {
    try {
      // Commander quirk: when subcommand options conflict with program options,
      // we need to check the parent program's options as fallback
      const parentOpts = command.parent?.opts() || {};
      const outputDir = options.output || parentOpts.output || 'room/';
      const verbose = options.verbose ?? parentOpts.verbose ?? false;

      // Determine generation mode
      const useLegacy = options.legacy === true;
      const modeLabel = useLegacy
        ? '[Legacy Single Tile Generation]'
        : '[Tile Sheet Generation]';

      console.log(`Generating room: ${theme} ${modeLabel}`);

      // Parse props list
      const props = options.props ? options.props.split(',').map(s => s.trim()).filter(Boolean) : [];

      // Load project references if applicable
      let projectReferences = [];
      if (options.project !== false) {
        try {
          projectReferences = await getStyleReferenceBuffers();
          if (projectReferences.length > 0 && verbose) {
            console.log(`Auto-injecting ${projectReferences.length} project reference(s)`);
          }
        } catch (e) {
          // Not in a project, that's fine
        }
      }

      // Choose generation function based on mode
      // Default: Tile Sheet Generation - generates all tiles in ONE AI call for style consistency
      // Legacy: Single Tile Generation - generates each tile separately (--legacy flag)
      const generateFn = useLegacy ? generateRoom : generateRoomWithSheet;

      const result = await generateFn(theme, {
        layout: options.layout,
        width: parseInt(options.width),
        height: parseInt(options.height),
        props,
        tileSize: options.size,
        style: options.style,
        referenceImage: options.reference,
        projectReferences,
        outputDir,
        verbose
      });

      console.log(`\nRoom generated successfully!`);
      console.log(`  Output directory: ${result.outputDir}`);
      console.log(`  Room size: ${result.layout.width}x${result.layout.height} tiles`);
      console.log(`  Tiles generated: ${result.tiles.length}`);
      console.log(`  Props generated: ${result.props.length}`);
      console.log(`\nOutput files:`);
      console.log(`  - room.json (Tiled map file)`);
      console.log(`  - tileset.json (Tiled tileset)`);
      console.log(`  - atlas.png (tile spritesheet)`);
      console.log(`  - tiles/ (individual tile images)`);
      if (result.props.length > 0) {
        console.log(`  - props/ (prop images)`);
      }
      console.log(`  - metadata.json (generation info)`);

      // Generate preview if QC enabled or explicitly requested
      if (options.qc || options.autoFix) {
        console.log('\nGenerating preview...');
        const previewPaths = await saveRoomPreview(result, { verbose });
        console.log(`  HTML preview: ${previewPaths.html}`);
        console.log(`  PNG preview: ${previewPaths.png}`);
      }

      // Run QC if enabled
      if (options.qc || options.autoFix) {
        console.log('\nRunning quality control...');
        const qcReport = await roomQC(result, {
          verbose,
          autoFix: options.autoFix || false,
          passThreshold: parseInt(options.qcThreshold) || 70,
          apiKey: process.env.GEMINI_API_KEY
        });

        console.log(`\nQC Result: ${qcReport.passed ? 'PASSED' : 'FAILED'}`);
        console.log(`  Score: ${qcReport.finalScore}/100`);
        console.log(`  Attempts: ${qcReport.attempt}`);

        if (qcReport.aiAnalysis?.issues?.length > 0) {
          console.log(`  Issues found: ${qcReport.aiAnalysis.issues.length}`);
          for (const issue of qcReport.aiAnalysis.issues.slice(0, 3)) {
            console.log(`    - ${issue.type}: ${issue.description}`);
          }
        }

        if (qcReport.aiAnalysis?.suggestions?.length > 0) {
          console.log('  Suggestions:');
          for (const suggestion of qcReport.aiAnalysis.suggestions.slice(0, 2)) {
            console.log(`    - ${suggestion}`);
          }
        }

        result.qcReport = qcReport;
      }

    } catch (error) {
      console.error('Error:', error.message);
      // Try to get verbose from either subcommand or parent options
      const showStack = options.verbose ?? command.parent?.opts()?.verbose ?? false;
      if (showStack) {
        console.error(error.stack);
      }
      process.exit(1);
    }
  });

program.parse();

// ============================================================================
// Process Existing Sprite Sheet Workflow
// ============================================================================
async function processExistingSpriteSheet(input, options) {
  const startTime = Date.now();

  try {
    const inputPath = path.resolve(input);

    if (!fs.existsSync(inputPath)) {
      console.error(`Error: Input file not found: ${inputPath}`);
      process.exit(1);
    }

    // Require rows and cols for processing
    if (!options.rows || !options.cols) {
      console.error('Error: Both --rows (-r) and --cols (-c) are required');
      console.error('Example: node src/index.js sprite.png -r 4 -c 2 -o output.apng');
      process.exit(1);
    }

    console.log(`\nGPU Cats Asset Factory v3.0\n`);
    console.log(`Input: ${inputPath}`);

    // Step 1: Detect frames
    console.log('\n[Step 1] Detecting frames...');
    const detection = await detectFrames(inputPath, {
      rows: parseInt(options.rows),
      cols: parseInt(options.cols),
      verbose: options.verbose
    });

    console.log(`  Grid: ${detection.cols} cols x ${detection.rows} rows`);
    console.log(`  Frame size: ${detection.frameWidth}x${detection.frameHeight}px`);
    console.log(`  Total frames: ${detection.frames.length}`);

    if (options.preview) {
      console.log('\nDetected frame coordinates:');
      detection.frames.forEach((frame, i) => {
        console.log(`  [${i}] x=${frame.x}, y=${frame.y}, ${frame.width}x${frame.height}`);
      });
      console.log('\nPreview complete. Run without --preview to generate animation.');
      return;
    }

    // Step 2: Extract frames
    console.log('\n[Step 2] Extracting frames...');
    let frameBuffers = await extractFrames(inputPath, detection.frames);
    console.log(`  Extracted ${frameBuffers.length} frames`);

    // Step 3: Process frames (background removal, alignment)
    if (options.process !== false) {
      console.log('\n[Step 3] Processing frames (AI background removal)...');
      frameBuffers = await processFrames(frameBuffers, {
        verbose: options.verbose,
        removeBg: true,
        alignContent: !options.autoFix, // Skip alignment if auto-fix will handle it
        useAI: true
      });

      if (options.debugFrames) {
        const debugDir = path.resolve(options.debugFrames);
        await saveDebugFrames(frameBuffers, debugDir, 'processed');
        console.log(`  Debug frames saved to ${debugDir}`);
      }
    }

    // Step 4: Auto-fix (detect bad frames, replace, stabilize)
    if (options.autoFix) {
      console.log('\n[Step 4] Autonomous quality control...');
      const fixResult = await autoFix(frameBuffers, {
        diffThreshold: 0.05,
        verbose: true
      });

      frameBuffers = fixResult.frames;

      if (fixResult.report.badFrames.length > 0) {
        console.log(`  Fixed ${fixResult.report.badFrames.length} bad frames`);
      }
      if (fixResult.report.stabilized) {
        console.log('  Animation stabilized (bottom-center anchor)');
      }
      if (!fixResult.report.verified) {
        console.log(`  Warning: ${fixResult.report.verificationDetails.issues.join(', ')}`);
      }

      if (options.debugFrames) {
        const debugDir = path.resolve(options.debugFrames);
        await saveDebugFrames(frameBuffers, debugDir, 'autofixed');
      }
    }

    // Step 5: Quality analysis
    console.log('\n[Step 5] Quality analysis...');
    const quality = await analyzeGifQuality(frameBuffers, { verbose: options.verbose });

    if (quality.quality === 'good') {
      console.log(`  Quality: ${quality.quality} - frames are well-aligned`);
    } else {
      console.log(`  Quality: ${quality.quality}`);
      if (quality.issues.length > 0) {
        quality.issues.forEach(issue => {
          console.log(`  Warning: ${issue.message}`);
        });
      }
    }

    // Step 6: Create animation
    const result = await encodeAnimation(frameBuffers, options);
    logResult(result, startTime, options);

  } catch (error) {
    console.error(`\nError: ${error.message}`);
    if (options.verbose) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

// ============================================================================
// Generate Single Animation Workflow
// ============================================================================
async function generateSingleAnimation(description, options) {
  const startTime = Date.now();

  try {
    console.log(`\nGPU Cats Asset Factory v3.0 - AI Generation\n`);
    console.log(`Description: "${description}"`);
    console.log(`Style: ${options.style}`);

    const rows = parseInt(options.rows);
    const cols = parseInt(options.cols);

    // Load reference image if provided
    let referenceImage = null;
    if (options.reference) {
      const refPath = path.resolve(options.reference);
      if (!fs.existsSync(refPath)) {
        console.error(`Error: Reference image not found: ${refPath}`);
        process.exit(1);
      }
      referenceImage = refPath;
      console.log(`Reference: ${refPath}`);
    } else {
      console.log('Warning: No reference image provided. Character consistency not guaranteed.');
    }

    // Load project references if in a project and --no-project not set
    let projectReferences = [];
    if (options.project !== false) {
      try {
        projectReferences = await getStyleReferenceBuffers();
        if (projectReferences.length > 0 && options.verbose) {
          console.log(`Auto-injecting ${projectReferences.length} project reference(s)`);
        }
      } catch (e) {
        // Not in a project, that's fine
      }
    }

    // Step 1: Generate sprite sheet
    console.log(`\n[Step 1] Generating ${cols}x${rows} sprite sheet...`);
    const sheetBuffer = await generateSpriteSheet({
      referenceImage,
      projectReferences,
      description,
      rows,
      cols,
      style: options.style,
      verbose: options.verbose
    });

    if (!sheetBuffer) {
      throw new Error('Failed to generate sprite sheet');
    }

    // Save sprite sheet temporarily
    const tempSheetPath = `/tmp/sprite2gif-sheet-${Date.now()}.png`;
    fs.writeFileSync(tempSheetPath, sheetBuffer);

    // Step 2: Detect frames
    console.log('\n[Step 2] Detecting frame layout...');
    const detection = await detectFrames(tempSheetPath, {
      rows,
      cols,
      verbose: options.verbose
    });

    console.log(`  Grid: ${detection.cols} cols x ${detection.rows} rows`);
    console.log(`  Frame size: ${detection.frameWidth}x${detection.frameHeight}px`);

    // Step 3: Extract frames
    console.log('\n[Step 3] Extracting frames...');
    let frameBuffers = await extractFrames(tempSheetPath, detection.frames);
    console.log(`  Extracted ${frameBuffers.length} frames`);

    // Clean up temp file
    try {
      fs.unlinkSync(tempSheetPath);
    } catch (err) {
      if (options.verbose) {
        console.log(`Warning: Could not delete temp file: ${err.message}`);
      }
    }

    // Step 4: Process frames
    console.log('\n[Step 4] Processing frames (AI background removal)...');
    frameBuffers = await processFrames(frameBuffers, {
      verbose: options.verbose,
      removeBg: true,
      alignContent: !options.autoFix,
      useAI: true
    });

    // Step 5: Auto-fix if enabled
    if (options.autoFix) {
      console.log('\n[Step 5] Autonomous quality control...');
      const fixResult = await autoFix(frameBuffers, {
        diffThreshold: 0.05,
        verbose: true
      });

      frameBuffers = fixResult.frames;

      if (fixResult.report.badFrames.length > 0) {
        console.log(`  Fixed ${fixResult.report.badFrames.length} bad frames`);
      }
      if (fixResult.report.stabilized) {
        console.log('  Animation stabilized (bottom-center anchor)');
      }
    }

    if (options.debugFrames) {
      const debugDir = path.resolve(options.debugFrames);
      await saveDebugFrames(frameBuffers, debugDir, 'generated');
      console.log(`  Debug frames saved to ${debugDir}`);
    }

    // Step 6: Quality analysis
    console.log('\n[Step 6] Quality analysis...');
    const quality = await analyzeGifQuality(frameBuffers, { verbose: options.verbose });
    console.log(`  Quality: ${quality.quality}`);

    // Step 7: Create animation
    const result = await encodeAnimation(frameBuffers, options, 'generated');
    logResult(result, startTime, options);

  } catch (error) {
    console.error(`\nError: ${error.message}`);
    if (options.verbose) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

// ============================================================================
// Generate Animation Set Workflow (idle, walk, typing, thinking)
// ============================================================================
async function generateAnimationSetWorkflow(options) {
  const startTime = Date.now();

  try {
    console.log(`\nGPU Cats Asset Factory v3.0 - Animation Set Generation\n`);
    console.log(`Style: ${options.style}`);

    if (!options.reference) {
      console.error('Error: --reference is required for animation set generation');
      console.error('Example: node src/index.js generate "cat" --animation-set --reference cat.png');
      process.exit(1);
    }

    const refPath = path.resolve(options.reference);
    if (!fs.existsSync(refPath)) {
      console.error(`Error: Reference image not found: ${refPath}`);
      process.exit(1);
    }
    console.log(`Reference: ${refPath}`);

    // Load project references if in a project and --no-project not set
    let projectReferences = [];
    if (options.project !== false) {
      try {
        projectReferences = await getStyleReferenceBuffers();
        if (projectReferences.length > 0 && options.verbose) {
          console.log(`Auto-injecting ${projectReferences.length} project reference(s)`);
        }
      } catch (e) {
        // Not in a project, that's fine
      }
    }

    // Define animation set
    const animations = [
      { name: 'idle', description: 'idle breathing animation', rows: 2, cols: 4 },
      { name: 'walk', description: 'walking cycle animation', rows: 2, cols: 4 },
      { name: 'typing', description: 'typing at keyboard animation', rows: 2, cols: 3 },
      { name: 'thinking', description: 'thinking with hand on chin animation', rows: 2, cols: 2 }
    ];

    console.log(`\n[Step 1] Generating ${animations.length} animation sprite sheets...`);
    console.log(`  Animations: ${animations.map(a => a.name).join(', ')}`);

    const results = await createAnimationSet({
      referenceImage: refPath,
      projectReferences,
      animations,
      style: options.style,
      verbose: options.verbose
    });

    // Process each generated sprite sheet
    // Determine output directory - handle both file paths and directory paths
    let outputDir;
    if (options.output) {
      const outputPath = options.output;
      // Check if it's a directory (ends with / or path.sep, or has no extension, or is an existing directory)
      if (outputPath.endsWith('/') || outputPath.endsWith(path.sep) || !path.extname(outputPath) || (fs.existsSync(outputPath) && fs.statSync(outputPath).isDirectory())) {
        outputDir = path.resolve(outputPath);
      } else {
        outputDir = path.resolve(path.dirname(outputPath));
      }
    } else {
      outputDir = process.cwd();
    }

    fs.mkdirSync(outputDir, { recursive: true });

    let successCount = 0;
    for (const anim of animations) {
      const sheetBuffer = results[anim.name];
      if (!sheetBuffer) {
        console.log(`  Warning: Failed to generate ${anim.name}`);
        continue;
      }

      console.log(`\n[Processing ${anim.name}]`);

      // Save sprite sheet temporarily
      const tempSheetPath = `/tmp/sprite2gif-${anim.name}-${Date.now()}.png`;
      fs.writeFileSync(tempSheetPath, sheetBuffer);

      // Detect and extract frames
      const detection = await detectFrames(tempSheetPath, {
        rows: anim.rows,
        cols: anim.cols,
        verbose: options.verbose
      });

      let frameBuffers = await extractFrames(tempSheetPath, detection.frames);
      try {
        fs.unlinkSync(tempSheetPath);
      } catch (err) {
        if (options.verbose) {
          console.log(`Warning: Could not delete temp file: ${err.message}`);
        }
      }

      // Process frames
      frameBuffers = await processFrames(frameBuffers, {
        verbose: false,
        removeBg: true,
        alignContent: !options.autoFix,
        useAI: true
      });

      // Auto-fix if enabled
      if (options.autoFix) {
        const fixResult = await autoFix(frameBuffers, {
          diffThreshold: 0.05,
          verbose: false
        });
        frameBuffers = fixResult.frames;
      }

      // Encode animation
      const format = options.format.toLowerCase();
      const ext = format === 'gif' ? '.gif' : '.apng';
      const outputPath = path.join(outputDir, `${anim.name}${ext}`);
      const delay = parseInt(options.delay);
      const loop = parseInt(options.loop);

      let result;
      if (format === 'gif') {
        result = await createGif(frameBuffers, outputPath, { delay, repeat: loop });
      } else {
        result = await createApng(frameBuffers, outputPath, { delay, repeat: loop });
      }

      console.log(`  Created: ${outputPath} (${(result.size / 1024).toFixed(1)} KB)`);
      successCount++;
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\nSuccess! Generated ${successCount}/${animations.length} animations in ${duration}s`);
    console.log(`Output directory: ${outputDir}`);

    if (options.open && successCount > 0) {
      const firstOutput = path.join(outputDir, `idle.${options.format === 'gif' ? 'gif' : 'apng'}`);
      if (fs.existsSync(firstOutput)) {
        exec(`open "${firstOutput}"`);
      }
    }

  } catch (error) {
    console.error(`\nError: ${error.message}`);
    if (options.verbose) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

// ============================================================================
// Shared Utilities
// ============================================================================

async function encodeAnimation(frameBuffers, options, defaultName = 'output') {
  const format = options.format.toLowerCase();
  const defaultExt = format === 'gif' ? '.gif' : '.apng';
  const outputPath = path.resolve(options.output || `${defaultName}${defaultExt}`);
  const delay = parseInt(options.delay);
  const loop = options.loop === false ? -1 : parseInt(options.loop);

  const formatName = format === 'gif' ? 'GIF' : 'APNG';
  console.log(`\n[Encoding] Creating ${formatName}...`);
  console.log(`  Format: ${formatName} ${format === 'apng' ? '(full alpha transparency)' : '(1-bit transparency)'}`);
  console.log(`  Delay: ${delay}ms per frame (${Math.round(1000 / delay)} fps)`);
  console.log(`  Loop: ${loop === 0 ? 'infinite' : loop === -1 ? 'none' : loop + ' times'}`);

  let result;
  if (format === 'gif') {
    result = await createGif(frameBuffers, outputPath, {
      width: null,
      height: null,
      delay,
      repeat: loop
    });
  } else {
    result = await createApng(frameBuffers, outputPath, {
      delay,
      repeat: loop
    });
  }

  result.outputPath = outputPath;
  return result;
}

function logResult(result, startTime, options) {
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  const fileSize = (result.size / 1024).toFixed(1);

  console.log(`\nSuccess!`);
  console.log(`  Output: ${result.outputPath}`);
  console.log(`  Size: ${fileSize} KB`);
  console.log(`  Dimensions: ${result.width}x${result.height}px`);
  console.log(`  Frames: ${result.frames}`);
  console.log(`  Time: ${duration}s\n`);

  if (options.open) {
    exec(`open "${result.outputPath}"`);
  }
}
