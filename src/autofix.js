import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import pixelmatch from 'pixelmatch';

/**
 * OPTIMAL SPRITE ANOMALY DETECTION & AUTO-FIX SYSTEM
 *
 * Uses multi-layer detection based on research:
 * 1. Color Histogram Analysis - catches color washout (primary for green head issue)
 * 2. Alpha Channel Analysis - catches transparency holes/bleeding
 * 3. SSIM-like Structural Check - catches structural damage
 * 4. Pixelmatch Outlier Detection - catches major changes
 *
 * Each method catches different failure modes of AI background removal.
 */

/**
 * Main auto-fix pipeline
 * @param {Array<Buffer>} frameBuffers - Array of PNG buffers after bg removal
 * @param {Object} options
 * @returns {Object} { frames: Buffer[], report: Object }
 */
export async function autoFix(frameBuffers, options = {}) {
  const {
    verbose = false,
    // Thresholds - tuned based on testing with actual bad frames
    // Key insight: Only flag frames that are SIGNIFICANT outliers
    // Frame 7 in test had green ratio of 0.26 - clearly bad
    // Normal frames vary from 0.91 to 1.18
    colorRatioThreshold = 0.35,     // Flag if < 35% of median color
    // Alpha analysis uses IQR-based outlier detection instead of fixed threshold
    opacityIQRMultiplier = 2.5,     // Flag if opacity outside Q1-2.5*IQR / Q3+2.5*IQR
    ssimThreshold = 0.55,           // Flag if SSIM < 0.55 (very lenient - animation varies a lot)
    pixelDiffThreshold = 0.15       // Flag if > 15% pixels different (more lenient)
  } = options;

  const report = {
    totalFrames: frameBuffers.length,
    badFrames: [],
    replacements: [],
    stabilized: false,
    detectionMethods: []
  };

  let frames = [...frameBuffers];

  // Step 1: Multi-layer anomaly detection
  if (verbose) console.log('  Running multi-layer anomaly detection...');

  const detectionResult = await detectBadFrames(frames, {
    colorRatioThreshold,
    opacityIQRMultiplier,
    ssimThreshold,
    pixelDiffThreshold,
    verbose
  });

  report.badFrames = detectionResult.badFrames;
  report.detectionMethods = detectionResult.methodsUsed;

  if (detectionResult.badFrames.length > 0) {
    if (verbose) {
      console.log(`  Found ${detectionResult.badFrames.length} bad frames:`);
      detectionResult.badFrames.forEach(b => {
        const reasons = b.reasons.map(r => r.type).join(', ');
        console.log(`    Frame ${b.index}: ${reasons}`);
      });
    }

    // Step 2: Replace bad frames with good neighbors
    frames = await replaceBadFrames(frames, detectionResult.badFrames);
    report.replacements = detectionResult.badFrames.map(b => ({
      badFrame: b.index,
      replacedWith: b.replacement,
      reasons: b.reasons
    }));

    if (verbose) {
      report.replacements.forEach(r => {
        console.log(`  Replaced frame ${r.badFrame} with frame ${r.replacedWith}`);
      });
    }
  } else {
    if (verbose) console.log('  All frames passed quality check');
  }

  // Step 3: Stabilize animation (bottom-center anchor)
  if (verbose) console.log('  Stabilizing animation...');
  frames = await stabilizeFrames(frames);
  report.stabilized = true;

  // Step 4: Final verification
  if (verbose) console.log('  Running final verification...');
  const finalCheck = await verifyFrames(frames);
  report.verified = finalCheck.passed;
  report.verificationDetails = finalCheck;

  if (verbose) {
    if (finalCheck.passed) {
      console.log('  Final verification: PASSED');
    } else {
      console.log(`  Final verification: WARNING - ${finalCheck.issues.join(', ')}`);
    }
  }

  return { frames, report };
}

/**
 * Multi-layer anomaly detection
 * Combines multiple detection methods to catch all failure modes
 */
async function detectBadFrames(frameBuffers, options) {
  const {
    colorRatioThreshold,
    opacityIQRMultiplier,
    ssimThreshold,
    pixelDiffThreshold,
    verbose
  } = options;

  const numFrames = frameBuffers.length;
  const methodsUsed = [];

  if (numFrames < 3) {
    return { badFrames: [], methodsUsed: [] };
  }

  // Analyze all frames
  const frameAnalysis = await Promise.all(
    frameBuffers.map(async (buf, idx) => {
      const { data, info } = await sharp(buf)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

      return {
        index: idx,
        data,
        width: info.width,
        height: info.height,
        ...analyzePixels(data, info.width, info.height)
      };
    })
  );

  // Calculate reference statistics (median of all frames)
  const stats = calculateMedianStats(frameAnalysis);

  // Track detected anomalies per frame
  const frameAnomalies = new Map();

  // ========== METHOD 1: Color Histogram Analysis ==========
  // Catches: Color washout (e.g., green head turning pale)
  methodsUsed.push('color_histogram');

  for (const frame of frameAnalysis) {
    const anomalies = [];

    // Check each color channel
    for (const channel of ['darkGreen', 'brown', 'darkPixels']) {
      const medianCount = stats.medians[channel];
      const frameCount = frame.colors[channel];

      if (medianCount > 50) { // Only check if color is present in animation
        const ratio = frameCount / medianCount;
        if (ratio < colorRatioThreshold) {
          anomalies.push({
            type: 'color_loss',
            channel,
            frameCount,
            medianCount,
            ratio,
            severity: ratio < 0.2 ? 'severe' : 'moderate'
          });
        }
      }
    }

    // Special check for green channel (common AI bg removal failure)
    if (stats.medians.darkGreen > 100) {
      const greenRatio = frame.colors.darkGreen / stats.medians.darkGreen;
      if (greenRatio < colorRatioThreshold) {
        const existing = anomalies.find(a => a.channel === 'darkGreen');
        if (!existing) {
          anomalies.push({
            type: 'green_washout',
            frameCount: frame.colors.darkGreen,
            medianCount: stats.medians.darkGreen,
            ratio: greenRatio,
            severity: greenRatio < 0.2 ? 'severe' : 'moderate'
          });
        }
      }
    }

    if (anomalies.length > 0) {
      frameAnomalies.set(frame.index, anomalies);
    }
  }

  // ========== METHOD 2: Alpha Channel Analysis ==========
  // Catches: Transparency holes, edge erosion, halo effects
  // Uses IQR-based outlier detection instead of fixed threshold
  methodsUsed.push('alpha_analysis');

  // Calculate IQR for opacity to detect true outliers
  const opacityValues = frameAnalysis.map(f => f.alpha.opaqueRatio);
  const sortedOpacity = [...opacityValues].sort((a, b) => a - b);
  const opacityQ1 = sortedOpacity[Math.floor(sortedOpacity.length * 0.25)];
  const opacityQ3 = sortedOpacity[Math.floor(sortedOpacity.length * 0.75)];
  const opacityIQR = opacityQ3 - opacityQ1;
  const opacityLowerBound = opacityQ1 - opacityIQRMultiplier * opacityIQR;
  const opacityUpperBound = opacityQ3 + opacityIQRMultiplier * opacityIQR;

  for (const frame of frameAnalysis) {
    // Only flag true outliers based on IQR
    if (frame.alpha.opaqueRatio < opacityLowerBound || frame.alpha.opaqueRatio > opacityUpperBound) {
      const anomalies = frameAnomalies.get(frame.index) || [];
      anomalies.push({
        type: frame.alpha.opaqueRatio < stats.medians.opaqueRatio
              ? 'transparency_hole' : 'extra_opacity',
        frameOpacity: frame.alpha.opaqueRatio,
        medianOpacity: stats.medians.opaqueRatio,
        bounds: { lower: opacityLowerBound, upper: opacityUpperBound },
        severity: frame.alpha.opaqueRatio < opacityLowerBound - opacityIQR ? 'severe' : 'moderate'
      });
      frameAnomalies.set(frame.index, anomalies);
    }

    // Check for halo effect - only flag if significantly more semi-transparent
    // Use a higher threshold and compare to Q3 instead of median
    const semiTransValues = frameAnalysis.map(f => f.alpha.semiTransRatio);
    const semiTransQ3 = [...semiTransValues].sort((a, b) => a - b)[Math.floor(semiTransValues.length * 0.75)];
    const semiTransDiff = frame.alpha.semiTransRatio - semiTransQ3;
    if (semiTransDiff > 0.08) { // Only flag significant halo effects
      const anomalies = frameAnomalies.get(frame.index) || [];
      anomalies.push({
        type: 'halo_effect',
        frameSemiTrans: frame.alpha.semiTransRatio,
        q3SemiTrans: semiTransQ3,
        increase: semiTransDiff,
        severity: semiTransDiff > 0.15 ? 'severe' : 'moderate'
      });
      frameAnomalies.set(frame.index, anomalies);
    }
  }

  // ========== METHOD 3: Structural Similarity (simplified SSIM-like) ==========
  // Catches: Structural damage, missing parts
  // Use ADJACENT frame comparison and IQR outlier detection
  // IMPORTANT: Only flag frames that are EXTREME outliers - animations have high natural variance
  methodsUsed.push('structural_similarity');

  const maxWidth = Math.max(...frameAnalysis.map(f => f.width));
  const maxHeight = Math.max(...frameAnalysis.map(f => f.height));

  const normalizedFrames = await Promise.all(
    frameBuffers.map(async (buf) => {
      return sharp(buf)
        .resize(maxWidth, maxHeight, {
          fit: 'contain',
          background: { r: 0, g: 0, b: 0, alpha: 0 }
        })
        .ensureAlpha()
        .raw()
        .toBuffer();
    })
  );

  // Calculate SSIM between adjacent frames
  const adjacentSSIM = [];
  for (let i = 0; i < numFrames - 1; i++) {
    const score = calculateSimplifiedSSIM(
      normalizedFrames[i],
      normalizedFrames[i + 1],
      maxWidth,
      maxHeight
    );
    adjacentSSIM.push({ fromFrame: i, toFrame: i + 1, score });
  }

  // Use IQR method to detect outliers with MUCH stricter bounds (3x IQR instead of 1.5x)
  // Only flag frames that are truly anomalous compared to the animation's own variance
  const ssimScores = adjacentSSIM.map(s => s.score);
  const sortedSSIM = [...ssimScores].sort((a, b) => a - b);
  const ssimQ1 = sortedSSIM[Math.floor(sortedSSIM.length * 0.25)];
  const ssimQ3 = sortedSSIM[Math.floor(sortedSSIM.length * 0.75)];
  const ssimIQR = ssimQ3 - ssimQ1;
  // Use 3x IQR for very strict outlier detection
  const ssimOutlierThreshold = ssimQ1 - 3.0 * ssimIQR;

  // Only flag if BOTH neighbors show low SSIM AND below absolute threshold
  // This ensures we catch actual damage, not normal animation variance
  for (let i = 1; i < numFrames - 1; i++) {
    const ssimToPrev = adjacentSSIM[i - 1].score;
    const ssimToNext = adjacentSSIM[i].score;

    // Both must be low (not just average) to indicate this frame is the problem
    const bothLow = ssimToPrev < ssimOutlierThreshold && ssimToNext < ssimOutlierThreshold;
    const veryLow = Math.min(ssimToPrev, ssimToNext) < ssimThreshold;

    if (bothLow && veryLow) {
      const anomalies = frameAnomalies.get(i) || [];
      anomalies.push({
        type: 'structural_damage',
        ssimToPrev,
        ssimToNext,
        threshold: ssimOutlierThreshold,
        severity: Math.min(ssimToPrev, ssimToNext) < 0.4 ? 'severe' : 'moderate'
      });
      frameAnomalies.set(i, anomalies);
    }
  }

  // ========== METHOD 4: Pixelmatch Outlier Detection ==========
  // Catches: Major unexpected changes between adjacent frames
  methodsUsed.push('pixel_outlier');

  const totalPixels = maxWidth * maxHeight;
  const consecutiveDiffs = [];

  for (let i = 0; i < numFrames - 1; i++) {
    const diff = pixelmatch(
      new Uint8Array(normalizedFrames[i]),
      new Uint8Array(normalizedFrames[i + 1]),
      null,
      maxWidth,
      maxHeight,
      { threshold: 0.1 }
    );
    consecutiveDiffs.push(diff / totalPixels);
  }

  const sortedDiffs = [...consecutiveDiffs].sort((a, b) => a - b);
  const medianDiff = sortedDiffs[Math.floor(sortedDiffs.length / 2)];
  const outlierThreshold = Math.max(medianDiff * 2.5, pixelDiffThreshold);

  // Check for outliers (frames that differ much more than normal)
  for (let i = 1; i < numFrames - 1; i++) {
    const avgDiff = (consecutiveDiffs[i - 1] + consecutiveDiffs[i]) / 2;
    if (avgDiff > outlierThreshold) {
      const anomalies = frameAnomalies.get(i) || [];
      // Only add if not already detected by other methods
      if (!anomalies.some(a => a.type === 'structural_damage')) {
        anomalies.push({
          type: 'pixel_outlier',
          avgDiff,
          medianDiff,
          threshold: outlierThreshold,
          severity: avgDiff > medianDiff * 4 ? 'severe' : 'moderate'
        });
        frameAnomalies.set(i, anomalies);
      }
    }
  }

  // Build final bad frames list with replacements
  const badFrames = [];
  const badIndices = new Set(frameAnomalies.keys());

  for (const [index, reasons] of frameAnomalies) {
    // Find best replacement (nearest good frame)
    let replacement = index > 0 ? index - 1 : index + 1;

    // Prefer frame before, unless it's also bad
    if (index > 0 && !badIndices.has(index - 1)) {
      replacement = index - 1;
    } else if (index < numFrames - 1 && !badIndices.has(index + 1)) {
      replacement = index + 1;
    } else {
      // Both neighbors are bad, find nearest good frame
      for (let dist = 2; dist < numFrames; dist++) {
        if (index - dist >= 0 && !badIndices.has(index - dist)) {
          replacement = index - dist;
          break;
        }
        if (index + dist < numFrames && !badIndices.has(index + dist)) {
          replacement = index + dist;
          break;
        }
      }
    }

    badFrames.push({
      index,
      reasons,
      replacement,
      severity: reasons.some(r => r.severity === 'severe') ? 'severe' : 'moderate'
    });
  }

  return {
    badFrames: badFrames.sort((a, b) => a.index - b.index),
    methodsUsed
  };
}

/**
 * Analyze pixels for color and alpha statistics
 */
function analyzePixels(data, width, height) {
  const colors = {
    darkGreen: 0,   // Duck head color
    brown: 0,       // Duck body
    darkPixels: 0,  // Vinyl record
    other: 0
  };

  const alpha = {
    opaque: 0,
    semiTrans: 0,
    transparent: 0
  };

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];

    // Alpha analysis
    if (a > 250) alpha.opaque++;
    else if (a > 5) alpha.semiTrans++;
    else alpha.transparent++;

    // Skip transparent pixels for color analysis
    if (a < 128) continue;

    // Dark green (duck head ~RGB 60-100, 100-160, 40-80)
    if (g > r && g > b && g > 80 && g < 180 && r < 130 && b < 110) {
      colors.darkGreen++;
    }
    // Brown (duck body)
    else if (r > 70 && r < 190 && g > 50 && g < 150 && b > 30 && b < 130
             && Math.abs(r - g) < 60) {
      colors.brown++;
    }
    // Dark (vinyl record)
    else if (r < 90 && g < 90 && b < 90) {
      colors.darkPixels++;
    }
    else {
      colors.other++;
    }
  }

  const totalPixels = width * height;

  return {
    colors,
    alpha: {
      opaqueRatio: alpha.opaque / totalPixels,
      semiTransRatio: alpha.semiTrans / totalPixels,
      transparentRatio: alpha.transparent / totalPixels
    }
  };
}

/**
 * Calculate median statistics across all frames
 */
function calculateMedianStats(frameAnalysis) {
  const getMedian = (arr) => {
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };

  return {
    medians: {
      darkGreen: getMedian(frameAnalysis.map(f => f.colors.darkGreen)),
      brown: getMedian(frameAnalysis.map(f => f.colors.brown)),
      darkPixels: getMedian(frameAnalysis.map(f => f.colors.darkPixels)),
      opaqueRatio: getMedian(frameAnalysis.map(f => f.alpha.opaqueRatio)),
      semiTransRatio: getMedian(frameAnalysis.map(f => f.alpha.semiTransRatio))
    }
  };
}

/**
 * Simplified SSIM calculation (luminance and structure comparison)
 */
function calculateSimplifiedSSIM(data1, data2, width, height) {
  const arr1 = new Uint8Array(data1);
  const arr2 = new Uint8Array(data2);

  let sum1 = 0, sum2 = 0;
  let sumSq1 = 0, sumSq2 = 0;
  let sumProd = 0;
  let count = 0;

  // Compare only opaque regions (alpha > 128)
  for (let i = 0; i < arr1.length; i += 4) {
    const a1 = arr1[i + 3], a2 = arr2[i + 3];

    // Only compare where both are somewhat opaque
    if (a1 > 64 || a2 > 64) {
      // Use grayscale luminance
      const l1 = 0.299 * arr1[i] + 0.587 * arr1[i + 1] + 0.114 * arr1[i + 2];
      const l2 = 0.299 * arr2[i] + 0.587 * arr2[i + 1] + 0.114 * arr2[i + 2];

      sum1 += l1;
      sum2 += l2;
      sumSq1 += l1 * l1;
      sumSq2 += l2 * l2;
      sumProd += l1 * l2;
      count++;
    }
  }

  if (count === 0) return 1; // Both empty

  const mean1 = sum1 / count;
  const mean2 = sum2 / count;
  const var1 = sumSq1 / count - mean1 * mean1;
  const var2 = sumSq2 / count - mean2 * mean2;
  const covar = sumProd / count - mean1 * mean2;

  const c1 = 6.5025;  // (0.01 * 255)^2
  const c2 = 58.5225; // (0.03 * 255)^2

  const ssim = ((2 * mean1 * mean2 + c1) * (2 * covar + c2)) /
               ((mean1 * mean1 + mean2 * mean2 + c1) * (var1 + var2 + c2));

  return ssim;
}

/**
 * Replace bad frames with nearest good neighbor
 */
async function replaceBadFrames(frameBuffers, badFrameInfos) {
  const frames = [...frameBuffers];

  for (const bad of badFrameInfos) {
    frames[bad.index] = frames[bad.replacement];
  }

  return frames;
}

/**
 * Stabilize animation using bottom-center anchoring
 */
async function stabilizeFrames(frameBuffers) {
  const frameData = await Promise.all(
    frameBuffers.map(async (buf) => {
      const { data, info } = await sharp(buf)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

      const bounds = findContentBounds(data, info.width, info.height);
      return { buf, bounds };
    })
  );

  const maxContentWidth = Math.max(...frameData.map(f => f.bounds.width));
  const maxContentHeight = Math.max(...frameData.map(f => f.bounds.height));

  const canvasWidth = maxContentWidth + 40;
  const canvasHeight = maxContentHeight + 40;

  const stabilized = await Promise.all(
    frameData.map(async ({ buf, bounds }) => {
      const content = await sharp(buf)
        .extract({
          left: bounds.x,
          top: bounds.y,
          width: bounds.width,
          height: bounds.height
        })
        .toBuffer();

      const left = Math.floor((canvasWidth - bounds.width) / 2);
      const top = canvasHeight - bounds.height;

      return sharp({
        create: {
          width: canvasWidth,
          height: canvasHeight,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 0 }
        }
      })
      .composite([{ input: content, left, top }])
      .png({ palette: false })
      .toBuffer();
    })
  );

  return stabilized;
}

/**
 * Find bounding box of non-transparent content
 */
function findContentBounds(data, width, height) {
  let minX = width, maxX = 0;
  let minY = height, maxY = 0;
  const ALPHA_THRESHOLD = 20;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      if (data[idx + 3] > ALPHA_THRESHOLD) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  }

  if (minX > maxX || minY > maxY) {
    return { x: 0, y: 0, width, height };
  }

  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1
  };
}

/**
 * Final verification pass
 */
async function verifyFrames(frameBuffers) {
  const issues = [];

  const metas = await Promise.all(frameBuffers.map(buf => sharp(buf).metadata()));
  const sizes = new Set(metas.map(m => `${m.width}x${m.height}`));

  if (sizes.size > 1) {
    issues.push(`Inconsistent frame sizes: ${[...sizes].join(', ')}`);
  }

  const numFrames = frameBuffers.length;
  if (numFrames > 2) {
    const maxWidth = metas[0].width;
    const maxHeight = metas[0].height;
    const totalPixels = maxWidth * maxHeight;

    const checkIndices = [0, Math.floor(numFrames / 2), numFrames - 1];
    const rawFrames = await Promise.all(
      checkIndices.map(i =>
        sharp(frameBuffers[i]).ensureAlpha().raw().toBuffer()
      )
    );

    for (let i = 0; i < rawFrames.length - 1; i++) {
      const diff = pixelmatch(
        new Uint8Array(rawFrames[i]),
        new Uint8Array(rawFrames[i + 1]),
        null,
        maxWidth,
        maxHeight,
        { threshold: 0.1 }
      );
      const diffRatio = diff / totalPixels;

      if (diffRatio > 0.30) {
        issues.push(`Large variance between frames (${(diffRatio * 100).toFixed(1)}%)`);
      }
    }
  }

  return { passed: issues.length === 0, issues };
}

/**
 * Save debug frames to disk
 */
export async function saveDebugFrames(frameBuffers, outputDir, label = 'debug') {
  fs.mkdirSync(outputDir, { recursive: true });

  for (let i = 0; i < frameBuffers.length; i++) {
    const outputPath = path.join(outputDir, `${label}_frame_${i}.png`);
    fs.writeFileSync(outputPath, frameBuffers[i]);
  }

  return outputDir;
}
