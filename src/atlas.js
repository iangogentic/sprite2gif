import sharp from 'sharp';

/**
 * GPU Cats Asset Factory - Atlas/Spritesheet Module
 *
 * Combines multiple tile images into a single spritesheet atlas
 * for use with Tiled map editor and game engines.
 */

/**
 * Create a texture atlas from tile images
 * Handles variable tile heights - uses max height, smaller tiles positioned at bottom
 * @param {Array} tiles - Array of { name: string, buffer: Buffer } objects
 * @param {Object} options - Atlas options
 * @param {number} options.tileWidth - Width of each tile (default: 64)
 * @param {number} options.tileHeight - Base height for floor tiles (default: 32)
 * @param {number} options.maxTileHeight - Max height for walls (default: 64, auto-detected if not set)
 * @param {number} options.columns - Max columns in atlas (default: 8)
 * @param {number} options.padding - Padding between tiles (default: 0)
 * @returns {Promise<Object>} { buffer, width, height, columns, rows, tilePositions }
 */
export async function createAtlas(tiles, options = {}) {
  const {
    tileWidth = 64,
    tileHeight = 32,
    columns = 8,
    padding = 0
  } = options;

  // Detect max tile height from actual tiles
  let maxTileHeight = options.maxTileHeight || tileHeight;
  for (const tile of tiles) {
    try {
      const meta = await sharp(tile.buffer).metadata();
      if (meta.height > maxTileHeight) {
        maxTileHeight = meta.height;
      }
    } catch (e) {
      // Ignore errors, use default
    }
  }

  // Use maxTileHeight for atlas cell height (to accommodate walls)
  const cellHeight = maxTileHeight;

  // Validate input
  if (!tiles || tiles.length === 0) {
    throw new Error('No tiles provided for atlas');
  }

  // Validate tile structure
  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i];
    if (!tile || typeof tile.name !== 'string') {
      throw new Error(`Invalid tile at index ${i}: missing or invalid 'name' property`);
    }
    if (!Buffer.isBuffer(tile.buffer)) {
      throw new Error(`Invalid tile at index ${i} (${tile.name}): 'buffer' must be a Buffer`);
    }
  }

  // Calculate dimensions using cellHeight for atlas rows
  const actualColumns = Math.min(columns, tiles.length);
  const rows = Math.ceil(tiles.length / actualColumns);

  // Use cellHeight (max tile height) for atlas cell dimensions
  const finalAtlasWidth = actualColumns * tileWidth + (actualColumns - 1) * padding;
  const finalAtlasHeight = rows * cellHeight + (rows - 1) * padding;

  // Build composite operations - position tiles at bottom of their cell
  const composites = await Promise.all(
    tiles.map(async (tile, index) => {
      const col = index % actualColumns;
      const row = Math.floor(index / actualColumns);

      // Get actual tile dimensions
      let inputBuffer = tile.buffer;
      let actualHeight = cellHeight;

      try {
        const meta = await sharp(tile.buffer).metadata();
        actualHeight = meta.height;

        // Ensure tile is correct width (resize width only if needed)
        if (meta.width !== tileWidth) {
          inputBuffer = await sharp(tile.buffer)
            .resize(tileWidth, meta.height, { fit: 'fill' })
            .png()
            .toBuffer();
        }
      } catch (err) {
        // If metadata fails, use original buffer
      }

      // Position tile at BOTTOM of cell (important for isometric rendering)
      const cellTop = row * (cellHeight + padding);
      const yOffset = cellHeight - actualHeight; // Push smaller tiles to bottom

      return {
        input: inputBuffer,
        left: col * (tileWidth + padding),
        top: cellTop + yOffset
      };
    })
  );

  // Create atlas image with transparent background
  const atlasBuffer = await sharp({
    create: {
      width: finalAtlasWidth,
      height: finalAtlasHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  })
    .composite(composites)
    .png()
    .toBuffer();

  // Build tile positions map (for Tiled tileset)
  // Use cellHeight for all tiles in Tiled (consistent cell size)
  const tilePositions = {};
  tiles.forEach((tile, index) => {
    const col = index % actualColumns;
    const row = Math.floor(index / actualColumns);
    tilePositions[tile.name] = {
      gid: index + 1,  // Tiled GIDs start at 1
      x: col * (tileWidth + padding),
      y: row * (cellHeight + padding),
      width: tileWidth,
      height: cellHeight  // Use cellHeight for consistent Tiled cells
    };
  });

  return {
    buffer: atlasBuffer,
    width: finalAtlasWidth,
    height: finalAtlasHeight,
    columns: actualColumns,
    rows,
    tileWidth,
    tileHeight: cellHeight,  // Use max height for Tiled compatibility
    maxTileHeight: cellHeight,
    baseTileHeight: tileHeight,
    tileCount: tiles.length,
    tilePositions
  };
}

/**
 * Get tile position in atlas by name
 * @param {Object} atlasInfo - Atlas info from createAtlas
 * @param {string} tileName - Tile name
 * @returns {Object|null} { x, y, width, height, gid } or null if not found
 */
export function getTilePosition(atlasInfo, tileName) {
  if (!atlasInfo || !atlasInfo.tilePositions) {
    return null;
  }
  return atlasInfo.tilePositions[tileName] || null;
}

/**
 * Get Tiled GID for a tile by name
 * @param {Object} atlasInfo - Atlas info from createAtlas
 * @param {string} tileName - Tile name
 * @returns {number} GID (1-based) or 0 if not found
 */
export function getGidForTile(atlasInfo, tileName) {
  if (!atlasInfo || !atlasInfo.tilePositions) {
    return 0;
  }
  const pos = atlasInfo.tilePositions[tileName];
  return pos ? pos.gid : 0;
}

/**
 * Get tile name by GID
 * @param {Object} atlasInfo - Atlas info from createAtlas
 * @param {number} gid - Tile GID (1-based)
 * @returns {string|null} Tile name or null if not found
 */
export function getTileNameByGid(atlasInfo, gid) {
  if (!atlasInfo || !atlasInfo.tilePositions || gid <= 0) {
    return null;
  }
  for (const [name, pos] of Object.entries(atlasInfo.tilePositions)) {
    if (pos.gid === gid) {
      return name;
    }
  }
  return null;
}

/**
 * Get all tile names in the atlas
 * @param {Object} atlasInfo - Atlas info from createAtlas
 * @returns {string[]} Array of tile names
 */
export function getTileNames(atlasInfo) {
  if (!atlasInfo || !atlasInfo.tilePositions) {
    return [];
  }
  return Object.keys(atlasInfo.tilePositions);
}

/**
 * Validate that an atlas has all required tiles
 * @param {Object} atlasInfo - Atlas info from createAtlas
 * @param {string[]} requiredTiles - Array of required tile names
 * @returns {Object} { valid: boolean, missing: string[] }
 */
export function validateAtlas(atlasInfo, requiredTiles) {
  if (!atlasInfo || !atlasInfo.tilePositions) {
    return { valid: false, missing: requiredTiles };
  }

  const missing = requiredTiles.filter(name => !atlasInfo.tilePositions[name]);
  return {
    valid: missing.length === 0,
    missing
  };
}
