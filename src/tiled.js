/**
 * GPU Cats Asset Factory - Tiled Export Module
 *
 * Exports room layouts to Tiled-compatible JSON files.
 * Compatible with:
 * - Tiled Map Editor v1.10
 * - GPU Cats (C++/OpenGL via tmxlite or nlohmann/json)
 * - Unity (native Tiled import)
 * - Godot (native Tiled import)
 * - Any engine with JSON parser
 */

/**
 * Generate Tiled map JSON
 * @param {Object} layout - Room layout { width, height, tiles, props }
 * @param {Object} atlasInfo - Atlas info from createAtlas
 * @param {Object} options - Export options
 * @param {string} options.name - Map name (default: 'room')
 * @param {number} options.tileWidth - Tile width (default: 64)
 * @param {number} options.tileHeight - Tile height (default: 32)
 * @returns {Object} Tiled map JSON object
 */
export function generateTiledMap(layout, atlasInfo, options = {}) {
  const {
    name = 'room',
    tileWidth = 64,
    tileHeight = 32
  } = options;

  // Validate inputs
  if (!layout || typeof layout.width !== 'number' || typeof layout.height !== 'number') {
    throw new Error('Invalid layout: must have width and height');
  }
  if (!layout.tiles || !Array.isArray(layout.tiles)) {
    throw new Error('Invalid layout: must have tiles array');
  }
  if (!atlasInfo || !atlasInfo.tilePositions) {
    throw new Error('Invalid atlasInfo: must have tilePositions');
  }

  // Convert layout tiles to GID data
  const tileData = layoutToTiledData(layout, atlasInfo);

  return {
    "version": "1.10",
    "tiledversion": "1.10.0",
    "orientation": "isometric",
    "renderorder": "right-down",
    "width": layout.width,
    "height": layout.height,
    "tilewidth": tileWidth,
    "tileheight": tileHeight,
    "infinite": false,
    "nextlayerid": 3,
    "nextobjectid": layout.props ? layout.props.length + 1 : 1,
    "layers": [
      {
        "id": 1,
        "name": "tiles",
        "type": "tilelayer",
        "x": 0,
        "y": 0,
        "width": layout.width,
        "height": layout.height,
        "visible": true,
        "opacity": 1,
        "data": tileData
      },
      {
        "id": 2,
        "name": "props",
        "type": "objectgroup",
        "x": 0,
        "y": 0,
        "visible": true,
        "opacity": 1,
        "objects": generatePropObjects(layout.props || [], tileWidth, tileHeight)
      }
    ],
    "tilesets": [
      {
        "firstgid": 1,
        "source": "tileset.json"
      }
    ]
  };
}

/**
 * Generate Tiled tileset JSON
 * @param {Object} atlasInfo - Atlas info from createAtlas
 * @param {Object} options - Options
 * @param {string} options.name - Tileset name (default: 'tileset')
 * @param {string} options.image - Atlas image filename (default: 'atlas.png')
 * @returns {Object} Tiled tileset JSON object
 */
export function generateTilesetJSON(atlasInfo, options = {}) {
  const {
    name = 'tileset',
    image = 'atlas.png'
  } = options;

  // Validate inputs
  if (!atlasInfo) {
    throw new Error('Invalid atlasInfo: must be provided');
  }
  if (typeof atlasInfo.tileWidth !== 'number' || typeof atlasInfo.tileHeight !== 'number') {
    throw new Error('Invalid atlasInfo: must have tileWidth and tileHeight');
  }
  if (typeof atlasInfo.tileCount !== 'number') {
    throw new Error('Invalid atlasInfo: must have tileCount');
  }
  if (typeof atlasInfo.columns !== 'number') {
    throw new Error('Invalid atlasInfo: must have columns');
  }
  if (typeof atlasInfo.width !== 'number' || typeof atlasInfo.height !== 'number') {
    throw new Error('Invalid atlasInfo: must have width and height');
  }

  return {
    "name": name,
    "tilewidth": atlasInfo.tileWidth,
    "tileheight": atlasInfo.tileHeight,
    "tilecount": atlasInfo.tileCount,
    "columns": atlasInfo.columns,
    "image": image,
    "imagewidth": atlasInfo.width,
    "imageheight": atlasInfo.height,
    "margin": 0,
    "spacing": 0
  };
}

/**
 * Convert layout tile types to Tiled GIDs
 * @param {Object} layout - Room layout
 * @param {Object} atlasInfo - Atlas info with tilePositions
 * @returns {number[]} Flat array of tile GIDs (row by row)
 */
export function layoutToTiledData(layout, atlasInfo) {
  // Validate inputs
  if (!layout || !layout.tiles || !Array.isArray(layout.tiles)) {
    throw new Error('Invalid layout: must have tiles array');
  }
  if (!atlasInfo || !atlasInfo.tilePositions) {
    throw new Error('Invalid atlasInfo: must have tilePositions');
  }

  const data = [];

  for (let y = 0; y < layout.height; y++) {
    // Ensure row exists
    if (!layout.tiles[y] || !Array.isArray(layout.tiles[y])) {
      // Fill with empty tiles if row is missing
      for (let x = 0; x < layout.width; x++) {
        data.push(0);
      }
      continue;
    }

    for (let x = 0; x < layout.width; x++) {
      const tileName = layout.tiles[y][x];

      // Handle empty/null tiles
      if (!tileName) {
        data.push(0);
        continue;
      }

      const position = atlasInfo.tilePositions[tileName];
      // Use GID if found, otherwise 0 (empty)
      data.push(position ? position.gid : 0);
    }
  }

  return data;
}

/**
 * Generate Tiled object array for props
 * @param {Array} props - Array of { type, gridX, gridY, properties? }
 * @param {number} tileWidth - Tile width for coordinate conversion
 * @param {number} tileHeight - Tile height for coordinate conversion
 * @returns {Array} Tiled objects array
 */
function generatePropObjects(props, tileWidth, tileHeight) {
  if (!Array.isArray(props)) {
    return [];
  }

  return props.map((prop, index) => {
    // Validate prop structure
    if (!prop || typeof prop.gridX !== 'number' || typeof prop.gridY !== 'number') {
      // Skip invalid props but log warning
      console.warn(`Skipping invalid prop at index ${index}: missing gridX or gridY`);
      return null;
    }

    return {
      "id": index + 1,
      "name": prop.type || `prop_${index + 1}`,
      "type": "prop",
      "x": prop.gridX * tileWidth,
      "y": prop.gridY * tileHeight,
      "width": prop.width || tileWidth,
      "height": prop.height || tileHeight,
      "visible": true,
      "properties": prop.properties || []
    };
  }).filter(Boolean); // Remove null entries from invalid props
}

/**
 * Validate a Tiled map JSON structure
 * @param {Object} tiledMap - Tiled map JSON object
 * @returns {Object} { valid: boolean, errors: string[] }
 */
export function validateTiledMap(tiledMap) {
  const errors = [];

  // Check required top-level properties
  const requiredProps = ['version', 'orientation', 'width', 'height', 'tilewidth', 'tileheight', 'layers'];
  for (const prop of requiredProps) {
    if (tiledMap[prop] === undefined) {
      errors.push(`Missing required property: ${prop}`);
    }
  }

  // Check layers
  if (Array.isArray(tiledMap.layers)) {
    for (let i = 0; i < tiledMap.layers.length; i++) {
      const layer = tiledMap.layers[i];
      if (!layer.id) errors.push(`Layer ${i}: missing id`);
      if (!layer.name) errors.push(`Layer ${i}: missing name`);
      if (!layer.type) errors.push(`Layer ${i}: missing type`);

      // Validate tile layer data
      if (layer.type === 'tilelayer') {
        if (!Array.isArray(layer.data)) {
          errors.push(`Layer ${i}: tilelayer missing data array`);
        } else {
          const expectedSize = tiledMap.width * tiledMap.height;
          if (layer.data.length !== expectedSize) {
            errors.push(`Layer ${i}: data length ${layer.data.length} does not match expected ${expectedSize}`);
          }
        }
      }

      // Validate object layer
      if (layer.type === 'objectgroup') {
        if (!Array.isArray(layer.objects)) {
          errors.push(`Layer ${i}: objectgroup missing objects array`);
        }
      }
    }
  }

  // Check tilesets
  if (Array.isArray(tiledMap.tilesets)) {
    for (let i = 0; i < tiledMap.tilesets.length; i++) {
      const tileset = tiledMap.tilesets[i];
      if (tileset.firstgid === undefined) {
        errors.push(`Tileset ${i}: missing firstgid`);
      }
      if (!tileset.source && !tileset.image) {
        errors.push(`Tileset ${i}: missing source or image`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Validate a Tiled tileset JSON structure
 * @param {Object} tileset - Tiled tileset JSON object
 * @returns {Object} { valid: boolean, errors: string[] }
 */
export function validateTilesetJSON(tileset) {
  const errors = [];

  const requiredProps = ['name', 'tilewidth', 'tileheight', 'tilecount', 'columns', 'image', 'imagewidth', 'imageheight'];
  for (const prop of requiredProps) {
    if (tileset[prop] === undefined) {
      errors.push(`Missing required property: ${prop}`);
    }
  }

  // Validate dimensions
  if (tileset.tilewidth && tileset.tilecount && tileset.columns && tileset.imagewidth) {
    const expectedWidth = tileset.columns * tileset.tilewidth;
    if (expectedWidth > tileset.imagewidth) {
      errors.push(`Image width ${tileset.imagewidth} is less than expected ${expectedWidth} (columns * tilewidth)`);
    }
  }

  if (tileset.tilewidth && tileset.tileheight && tileset.tilecount && tileset.columns && tileset.imageheight) {
    const rows = Math.ceil(tileset.tilecount / tileset.columns);
    const expectedHeight = rows * tileset.tileheight;
    if (expectedHeight > tileset.imageheight) {
      errors.push(`Image height ${tileset.imageheight} is less than expected ${expectedHeight} (rows * tileheight)`);
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}
