import sharp from 'sharp';
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { GoogleGenAI } from '@google/genai';
import { renderRoomToBuffer } from './preview.js';
import { generateTile } from './generator.js';

/**
 * Room Quality Control System
 *
 * Flow: RENDER -> ANALYZE (programmatic + AI) -> DETECT ISSUES -> FIX -> VERIFY
 */

// ===== TILE ANALYSIS =====

/**
 * Analyze pixel data for quality metrics
 * Adapted from autofix.js pattern
 */
function analyzePixels(data, width, height, channels = 4) {
  let totalPixels = 0;
  let transparentPixels = 0;
  let opaquePixels = 0;

  // Color buckets
  const colors = {
    darkPixels: 0,
    lightPixels: 0,
    saturatedPixels: 0,
    neutralPixels: 0
  };

  for (let i = 0; i < data.length; i += channels) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3];

    totalPixels++;

    if (a < 20) {
      transparentPixels++;
      continue;
    }

    opaquePixels++;

    const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const saturation = max === 0 ? 0 : (max - min) / max;

    if (luminance < 50) colors.darkPixels++;
    if (luminance > 200) colors.lightPixels++;
    if (saturation > 0.5) colors.saturatedPixels++;
    if (saturation < 0.15) colors.neutralPixels++;
  }

  return {
    totalPixels,
    transparentPixels,
    opaquePixels,
    transparentRatio: transparentPixels / totalPixels,
    colors,
    colorRatios: {
      dark: colors.darkPixels / Math.max(opaquePixels, 1),
      light: colors.lightPixels / Math.max(opaquePixels, 1),
      saturated: colors.saturatedPixels / Math.max(opaquePixels, 1),
      neutral: colors.neutralPixels / Math.max(opaquePixels, 1)
    }
  };
}

/**
 * Find content bounding box in image
 */
async function findContentBounds(buffer) {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  let minX = width, minY = height, maxX = 0, maxY = 0;
  let hasContent = false;
  const alphaThreshold = 20;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * channels;
      const alpha = data[idx + 3];

      if (alpha > alphaThreshold) {
        hasContent = true;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  }

  if (!hasContent) return null;

  return {
    left: minX,
    top: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
    contentRatio: ((maxX - minX + 1) * (maxY - minY + 1)) / (width * height)
  };
}

/**
 * Analyze a single tile for quality issues
 */
export async function analyzeTileQuality(tileBuffer, tileName, options = {}) {
  const { expectedWidth = 64, expectedHeight = 32 } = options;

  const metadata = await sharp(tileBuffer).metadata();
  const { data, info } = await sharp(tileBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const stats = analyzePixels(data, info.width, info.height, info.channels);
  const bounds = await findContentBounds(tileBuffer);

  const issues = [];

  // Check 1: Dimensions
  if (metadata.width !== expectedWidth || metadata.height !== expectedHeight) {
    issues.push({
      type: 'wrong_dimensions',
      severity: 'high',
      detail: `Expected ${expectedWidth}x${expectedHeight}, got ${metadata.width}x${metadata.height}`
    });
  }

  // Check 2: Too transparent (empty tile)
  if (stats.transparentRatio > 0.9) {
    issues.push({
      type: 'too_transparent',
      severity: 'high',
      detail: `${(stats.transparentRatio * 100).toFixed(1)}% transparent`
    });
  }

  // Check 3: Content doesn't fill tile (floating in center)
  if (bounds && bounds.contentRatio < 0.3) {
    issues.push({
      type: 'sparse_content',
      severity: 'medium',
      detail: `Content only fills ${(bounds.contentRatio * 100).toFixed(1)}% of tile`
    });
  }

  // Check 4: No content at all
  if (!bounds) {
    issues.push({
      type: 'no_content',
      severity: 'high',
      detail: 'Tile has no visible content'
    });
  }

  return {
    tileName,
    width: metadata.width,
    height: metadata.height,
    format: metadata.format,
    stats,
    bounds,
    issues,
    passed: issues.filter(i => i.severity === 'high').length === 0
  };
}

/**
 * Check consistency across all tiles in a tileset
 * Uses IQR-based outlier detection like autofix.js
 */
export async function checkTilesetConsistency(tileBuffers, options = {}) {
  const { verbose = false } = options;

  const tileNames = Object.keys(tileBuffers);
  if (tileNames.length < 2) {
    return { consistent: true, issues: [], analyses: [] };
  }

  // Analyze all tiles
  const analyses = [];
  for (const name of tileNames) {
    const analysis = await analyzeTileQuality(tileBuffers[name], name);
    analyses.push(analysis);
  }

  // Calculate statistics across tiles
  const saturatedValues = analyses.map(a => a.stats.colorRatios.saturated);
  const darkValues = analyses.map(a => a.stats.colorRatios.dark);

  // IQR outlier detection
  const issues = [];

  function findOutliers(values, names, metric) {
    const sorted = [...values].sort((a, b) => a - b);
    const q1 = sorted[Math.floor(sorted.length * 0.25)];
    const q3 = sorted[Math.floor(sorted.length * 0.75)];
    const iqr = q3 - q1;
    const lower = q1 - 2.0 * iqr;
    const upper = q3 + 2.0 * iqr;

    const outliers = [];
    values.forEach((v, i) => {
      if (v < lower || v > upper) {
        outliers.push({ name: names[i], value: v, metric });
      }
    });
    return outliers;
  }

  const satOutliers = findOutliers(saturatedValues, tileNames, 'saturation');
  const darkOutliers = findOutliers(darkValues, tileNames, 'darkness');

  for (const outlier of [...satOutliers, ...darkOutliers]) {
    issues.push({
      type: 'style_inconsistency',
      severity: 'medium',
      tileName: outlier.name,
      detail: `${outlier.name} is an outlier in ${outlier.metric}`
    });
  }

  return {
    consistent: issues.length === 0,
    issues,
    analyses
  };
}

// ===== AI ANALYSIS =====

/**
 * Analyze rendered room preview with Gemini AI
 */
export async function analyzeRoomWithAI(previewBuffer, options = {}) {
  const {
    apiKey = process.env.GEMINI_API_KEY,
    verbose = false,
    theme = ''
  } = options;

  if (!apiKey) {
    throw new Error('GEMINI_API_KEY required for AI analysis');
  }

  const ai = new GoogleGenAI({ apiKey });

  if (verbose) {
    console.log('  Sending room preview to AI for analysis...');
  }

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.0-flash',
      contents: [
        {
          inlineData: {
            mimeType: 'image/png',
            data: previewBuffer.toString('base64')
          }
        },
        {
          text: `You are a game art quality inspector. Analyze this isometric room render.

Theme requested: "${theme || 'not specified'}"

Evaluate these aspects (score each 1-10):

1. STYLE CONSISTENCY: Do all tiles share the same art style, color palette, and level of detail?
2. TILE ALIGNMENT: Are tiles properly aligned? Any visible seams or gaps?
3. CORNER CONNECTIONS: Do corner tiles connect smoothly with walls?
4. PERSPECTIVE: Is isometric perspective consistent across all tiles?
5. WALL ORIENTATION: Are the walls showing their INTERIOR surfaces? (You should be looking INTO the room, seeing the inside of the walls, not the outside/exterior)
6. OVERALL QUALITY: Does this look like a polished, game-ready room?

CRITICAL CHECK - WALL FACING:
- The back walls (forming an L-shape) should show INTERIOR surfaces
- You should feel like you're standing INSIDE the room looking at interior walls
- If walls look like exterior/outside surfaces, score wall_orientation as 1

For each issue found, identify the affected tile type if possible (floor, wall, corner).

Respond with ONLY valid JSON in this exact format:
{
  "scores": {
    "styleConsistency": 7,
    "tileAlignment": 8,
    "cornerConnections": 6,
    "perspective": 8,
    "overallQuality": 7
  },
  "overallScore": 72,
  "pass": true,
  "issues": [
    {
      "type": "style_mismatch",
      "affectedTile": "corner_nw",
      "severity": "medium",
      "description": "Corner tile has different shading than walls"
    }
  ],
  "suggestions": [
    "Regenerate corner tiles with consistent lighting"
  ]
}`
        }
      ],
      generationConfig: {
        temperature: 0.1 // Low temperature for consistent analysis
      }
    });

    const text = response.candidates?.[0]?.content?.parts?.[0]?.text || '';

    // Extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0]);
      if (verbose) {
        console.log(`  AI Score: ${result.overallScore}/100`);
      }
      return result;
    }

    // Fallback if parsing fails
    return {
      scores: {},
      overallScore: 50,
      pass: false,
      issues: [{ type: 'parse_error', severity: 'low', description: 'Could not parse AI response' }],
      suggestions: [],
      rawResponse: text
    };

  } catch (error) {
    if (verbose) {
      console.log(`  AI analysis error: ${error.message}`);
    }
    return {
      scores: {},
      overallScore: 0,
      pass: false,
      issues: [{ type: 'api_error', severity: 'high', description: error.message }],
      suggestions: [],
      error: error.message
    };
  }
}

// ===== AUTO-FIX =====

/**
 * Identify which tiles need regeneration based on QC results
 */
export function identifyTilesToRegenerate(tileAnalyses, aiAnalysis) {
  const tilesToFix = new Set();

  // From programmatic analysis
  for (const analysis of tileAnalyses) {
    if (!analysis.passed) {
      tilesToFix.add(analysis.tileName);
    }
  }

  // From AI analysis
  if (aiAnalysis?.issues) {
    for (const issue of aiAnalysis.issues) {
      if (issue.affectedTile && issue.severity !== 'low') {
        tilesToFix.add(issue.affectedTile);
      }
    }
  }

  return Array.from(tilesToFix);
}

/**
 * Regenerate specific tiles with improved prompts
 */
export async function regenerateTiles(tilesToFix, options = {}) {
  const {
    theme,
    tileSize = '64x32',
    style = 'isometric pixel art',
    outputDir,
    referenceImage,
    apiKey = process.env.GEMINI_API_KEY,
    verbose = false
  } = options;

  const results = [];

  for (const tileName of tilesToFix) {
    if (verbose) {
      console.log(`  Regenerating: ${tileName}`);
    }

    // Map tile name to type
    const tileType = tileName.replace(/_/g, '-');

    try {
      const outputPath = path.join(outputDir, 'tiles', `${tileName}.png`);

      await generateTile(theme, {
        type: tileType,
        tileSize,
        style,
        referenceImage,
        outputPath,
        apiKey,
        verbose: false
      });

      results.push({ tileName, success: true, path: outputPath });

    } catch (error) {
      results.push({ tileName, success: false, error: error.message });
      if (verbose) {
        console.log(`    Failed: ${error.message}`);
      }
    }
  }

  return results;
}

// ===== MAIN QC PIPELINE =====

/**
 * Main room quality control function
 *
 * @param {Object} roomResult - Result from generateRoom()
 * @param {Object} options - QC options
 * @returns {Promise<Object>} QC report with pass/fail, issues, and optionally fixed room
 */
export async function roomQC(roomResult, options = {}) {
  const {
    verbose = false,
    autoFix = true,
    maxRetries = 2,
    passThreshold = 70,
    apiKey = process.env.GEMINI_API_KEY
  } = options;

  const report = {
    passed: false,
    attempt: 0,
    tileAnalyses: [],
    consistencyCheck: null,
    aiAnalysis: null,
    tilesToFix: [],
    fixResults: [],
    finalScore: 0
  };

  // Load tile buffers
  const tileBuffers = {};
  const tilesDir = path.join(roomResult.outputDir, 'tiles');
  const tileFiles = await fsPromises.readdir(tilesDir);

  for (const file of tileFiles) {
    if (file.endsWith('.png')) {
      const name = path.basename(file, '.png');
      tileBuffers[name] = await fsPromises.readFile(path.join(tilesDir, file));
    }
  }

  // QC Loop
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    report.attempt = attempt + 1;

    if (verbose) {
      console.log(`\n  QC Attempt ${attempt + 1}/${maxRetries + 1}`);
    }

    // Step 1: Analyze individual tiles
    if (verbose) console.log('  Step 1: Analyzing tiles...');
    report.tileAnalyses = [];
    for (const [name, buffer] of Object.entries(tileBuffers)) {
      const analysis = await analyzeTileQuality(buffer, name);
      report.tileAnalyses.push(analysis);
      if (!analysis.passed && verbose) {
        console.log(`    ${name}: ${analysis.issues.length} issue(s)`);
      }
    }

    // Step 2: Check consistency
    if (verbose) console.log('  Step 2: Checking consistency...');
    report.consistencyCheck = await checkTilesetConsistency(tileBuffers, { verbose });

    // Step 3: Render preview
    if (verbose) console.log('  Step 3: Rendering preview...');
    const previewBuffer = await renderRoomToBuffer(roomResult.layout, tileBuffers, { verbose });

    // Save preview for debugging
    const previewPath = path.join(roomResult.outputDir, 'preview.png');
    await fsPromises.writeFile(previewPath, previewBuffer);

    // Step 4: AI Analysis
    if (verbose) console.log('  Step 4: AI analysis...');
    report.aiAnalysis = await analyzeRoomWithAI(previewBuffer, {
      apiKey,
      verbose,
      theme: roomResult.metadata?.theme
    });

    report.finalScore = report.aiAnalysis.overallScore || 0;

    // Step 5: Determine pass/fail
    const highSeverityTileIssues = report.tileAnalyses
      .flatMap(a => a.issues)
      .filter(i => i.severity === 'high').length;

    const highSeverityAIIssues = (report.aiAnalysis.issues || [])
      .filter(i => i.severity === 'high').length;

    report.passed = highSeverityTileIssues === 0 &&
                    highSeverityAIIssues === 0 &&
                    report.finalScore >= passThreshold;

    if (verbose) {
      console.log(`  Score: ${report.finalScore}/100, Pass: ${report.passed}`);
    }

    // Step 6: Auto-fix if needed and allowed
    if (report.passed || !autoFix || attempt >= maxRetries) {
      break;
    }

    // Identify tiles to regenerate
    report.tilesToFix = identifyTilesToRegenerate(
      report.tileAnalyses,
      report.aiAnalysis
    );

    if (report.tilesToFix.length === 0) {
      if (verbose) console.log('  No specific tiles identified for regeneration');
      break;
    }

    if (verbose) {
      console.log(`  Regenerating ${report.tilesToFix.length} tiles: ${report.tilesToFix.join(', ')}`);
    }

    // Regenerate problem tiles
    report.fixResults = await regenerateTiles(report.tilesToFix, {
      theme: roomResult.metadata?.theme,
      tileSize: `${roomResult.metadata?.tileSize?.width || 64}x${roomResult.metadata?.tileSize?.height || 32}`,
      outputDir: roomResult.outputDir,
      apiKey,
      verbose
    });

    // Reload fixed tiles
    for (const result of report.fixResults) {
      if (result.success) {
        tileBuffers[result.tileName] = await fsPromises.readFile(result.path);
      }
    }
  }

  return report;
}

/**
 * Quick QC check without auto-fix
 */
export async function quickQC(roomResult, options = {}) {
  return roomQC(roomResult, { ...options, autoFix: false, maxRetries: 0 });
}
