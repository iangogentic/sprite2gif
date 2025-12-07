/**
 * GPU Cats Asset Factory - Room Layout Module
 *
 * Provides room layout templates and procedural generation for isometric rooms.
 * Used by the room generation pipeline to define tile placement before rendering.
 *
 * Tile Coordinate System:
 * - Origin (0,0) is top-left corner
 * - X increases left-to-right (columns)
 * - Y increases top-to-bottom (rows)
 * - Tiles are placed in a 2D grid that maps to isometric projection
 */

/**
 * Valid tile type metadata
 * Maps tile type strings to their category and positioning information
 */
export const TILE_TYPES = {
  'floor': { category: 'floor' },
  'wall-n': { category: 'wall', direction: 'north' },
  'wall-s': { category: 'wall', direction: 'south' },
  'wall-e': { category: 'wall', direction: 'east' },
  'wall-w': { category: 'wall', direction: 'west' },
  'corner-nw': { category: 'corner', position: 'northwest' },
  'corner-ne': { category: 'corner', position: 'northeast' },
  'corner-sw': { category: 'corner', position: 'southwest' },
  'corner-se': { category: 'corner', position: 'southeast' },
  'empty': { category: 'empty' }
};

/**
 * Pre-defined room layout templates
 * Each template includes dimensions, tile grid, and default prop placements
 */
export const ROOM_TEMPLATES = {
  'office-small': {
    name: 'office-small',
    width: 6,
    height: 5,
    // Isometric room - only BACK walls (N, W) shown to allow viewing inside
    // Front edges (S, E) are floor-level only
    tiles: [
      ['corner-nw', 'wall-n', 'wall-n', 'wall-n', 'wall-n', 'corner-ne'],
      ['wall-w', 'floor', 'floor', 'floor', 'floor', 'floor'],
      ['wall-w', 'floor', 'floor', 'floor', 'floor', 'floor'],
      ['wall-w', 'floor', 'floor', 'floor', 'floor', 'floor'],
      ['corner-sw', 'floor', 'floor', 'floor', 'floor', 'corner-se']
    ],
    defaultProps: [
      { type: 'desk', gridX: 2, gridY: 2 },
      { type: 'chair', gridX: 2, gridY: 3 }
    ]
  },

  'office-large': {
    name: 'office-large',
    width: 10,
    height: 8,
    tiles: [
      ['corner-nw', 'wall-n', 'wall-n', 'wall-n', 'wall-n', 'wall-n', 'wall-n', 'wall-n', 'wall-n', 'corner-ne'],
      ['wall-w', 'floor', 'floor', 'floor', 'floor', 'floor', 'floor', 'floor', 'floor', 'wall-e'],
      ['wall-w', 'floor', 'floor', 'floor', 'floor', 'floor', 'floor', 'floor', 'floor', 'wall-e'],
      ['wall-w', 'floor', 'floor', 'floor', 'floor', 'floor', 'floor', 'floor', 'floor', 'wall-e'],
      ['wall-w', 'floor', 'floor', 'floor', 'floor', 'floor', 'floor', 'floor', 'floor', 'wall-e'],
      ['wall-w', 'floor', 'floor', 'floor', 'floor', 'floor', 'floor', 'floor', 'floor', 'wall-e'],
      ['wall-w', 'floor', 'floor', 'floor', 'floor', 'floor', 'floor', 'floor', 'floor', 'wall-e'],
      ['corner-sw', 'wall-s', 'wall-s', 'wall-s', 'wall-s', 'wall-s', 'wall-s', 'wall-s', 'wall-s', 'corner-se']
    ],
    defaultProps: [
      { type: 'desk', gridX: 2, gridY: 2 },
      { type: 'chair', gridX: 2, gridY: 3 },
      { type: 'desk', gridX: 5, gridY: 2 },
      { type: 'chair', gridX: 5, gridY: 3 },
      { type: 'plant', gridX: 8, gridY: 1 },
      { type: 'bookshelf', gridX: 1, gridY: 5 }
    ]
  },

  'hallway': {
    name: 'hallway',
    width: 3,
    height: 8,
    tiles: [
      ['corner-nw', 'wall-n', 'corner-ne'],
      ['wall-w', 'floor', 'wall-e'],
      ['wall-w', 'floor', 'wall-e'],
      ['wall-w', 'floor', 'wall-e'],
      ['wall-w', 'floor', 'wall-e'],
      ['wall-w', 'floor', 'wall-e'],
      ['wall-w', 'floor', 'wall-e'],
      ['corner-sw', 'wall-s', 'corner-se']
    ],
    defaultProps: [
      { type: 'light', gridX: 1, gridY: 2 },
      { type: 'light', gridX: 1, gridY: 5 }
    ]
  }
};

/**
 * List available template names
 * @returns {string[]} Array of template names
 */
export function listTemplates() {
  return Object.keys(ROOM_TEMPLATES);
}

/**
 * Get a room layout from a predefined template
 * Returns a deep copy to prevent mutation of the original template
 *
 * @param {string} templateName - Name of the template to retrieve
 * @returns {Object} Layout object { name, width, height, tiles, defaultProps }
 * @throws {Error} If template name is not found
 */
export function getTemplate(templateName) {
  const template = ROOM_TEMPLATES[templateName];

  if (!template) {
    const available = listTemplates().join(', ');
    throw new Error(`Unknown template: ${templateName}. Available: ${available}`);
  }

  // Return a deep copy to prevent mutation
  return {
    name: template.name,
    width: template.width,
    height: template.height,
    tiles: template.tiles.map(row => [...row]),
    defaultProps: template.defaultProps.map(prop => ({ ...prop }))
  };
}

/**
 * Generate a procedural room layout
 * Creates a rectangular room with walls around edges and floor in the center
 *
 * @param {number} width - Room width in tiles (minimum 3)
 * @param {number} height - Room height in tiles (minimum 3)
 * @param {Object} options - Generation options
 * @param {boolean} options.includeProps - Whether to add default props (default: false)
 * @param {string} options.floorType - Type of floor tile to use (default: 'floor')
 * @returns {Object} Layout object { width, height, tiles, props }
 * @throws {Error} If dimensions are too small
 */
export function generateLayout(width, height, options = {}) {
  const {
    includeProps = false,
    floorType = 'floor'
  } = options;

  // Validate minimum dimensions
  if (width < 3) {
    throw new Error(`Width must be at least 3, got ${width}`);
  }
  if (height < 3) {
    throw new Error(`Height must be at least 3, got ${height}`);
  }

  // Validate width and height are integers
  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    throw new Error('Width and height must be integers');
  }

  const tiles = [];

  for (let y = 0; y < height; y++) {
    const row = [];

    for (let x = 0; x < width; x++) {
      let tile;

      // Determine tile type based on position
      const isTop = y === 0;
      const isBottom = y === height - 1;
      const isLeft = x === 0;
      const isRight = x === width - 1;

      if (isTop && isLeft) {
        tile = 'corner-nw';
      } else if (isTop && isRight) {
        tile = 'corner-ne';
      } else if (isBottom && isLeft) {
        tile = 'corner-sw';
      } else if (isBottom && isRight) {
        tile = 'corner-se';
      } else if (isTop) {
        tile = 'wall-n';
      } else if (isBottom) {
        tile = 'wall-s';
      } else if (isLeft) {
        tile = 'wall-w';
      } else if (isRight) {
        tile = 'wall-e';
      } else {
        tile = floorType;
      }

      row.push(tile);
    }

    tiles.push(row);
  }

  const layout = {
    width,
    height,
    tiles,
    props: []
  };

  // Optionally add some default props in the center area
  if (includeProps) {
    const centerX = Math.floor(width / 2);
    const centerY = Math.floor(height / 2);

    // Only add props if there's enough interior space
    if (width > 4 && height > 4) {
      layout.props.push({ type: 'desk', gridX: centerX, gridY: centerY });
    }
  }

  return layout;
}

/**
 * Validate a room layout object
 * Checks structure, dimensions, and tile type validity
 *
 * @param {Object} layout - Layout object to validate
 * @returns {Object} Validation result { valid: boolean, errors: string[] }
 */
export function validateLayout(layout) {
  const errors = [];

  // Check required properties exist
  if (!layout) {
    return { valid: false, errors: ['Layout is null or undefined'] };
  }

  if (typeof layout.width !== 'number') {
    errors.push('Missing or invalid width property');
  }

  if (typeof layout.height !== 'number') {
    errors.push('Missing or invalid height property');
  }

  if (!Array.isArray(layout.tiles)) {
    errors.push('Missing or invalid tiles array');
    return { valid: false, errors };
  }

  // Check tiles array dimensions match width/height
  if (layout.tiles.length !== layout.height) {
    errors.push(`Tiles array has ${layout.tiles.length} rows, expected ${layout.height}`);
  }

  // Check each row
  for (let y = 0; y < layout.tiles.length; y++) {
    const row = layout.tiles[y];

    if (!Array.isArray(row)) {
      errors.push(`Row ${y} is not an array`);
      continue;
    }

    if (row.length !== layout.width) {
      errors.push(`Row ${y} has ${row.length} columns, expected ${layout.width}`);
    }

    // Check each tile type is valid
    for (let x = 0; x < row.length; x++) {
      const tileType = row[x];

      if (typeof tileType !== 'string') {
        errors.push(`Tile at (${x}, ${y}) is not a string: ${typeof tileType}`);
      } else if (!TILE_TYPES[tileType]) {
        errors.push(`Invalid tile type at (${x}, ${y}): "${tileType}"`);
      }
    }
  }

  // Validate props if present
  if (layout.props && Array.isArray(layout.props)) {
    for (let i = 0; i < layout.props.length; i++) {
      const prop = layout.props[i];

      if (!prop.type) {
        errors.push(`Prop ${i} is missing type property`);
      }

      if (typeof prop.gridX !== 'number' || typeof prop.gridY !== 'number') {
        errors.push(`Prop ${i} has invalid grid coordinates`);
      } else {
        // Check prop is within bounds
        if (prop.gridX < 0 || prop.gridX >= layout.width) {
          errors.push(`Prop ${i} gridX (${prop.gridX}) is out of bounds`);
        }
        if (prop.gridY < 0 || prop.gridY >= layout.height) {
          errors.push(`Prop ${i} gridY (${prop.gridY}) is out of bounds`);
        }
      }
    }
  }

  // Also validate defaultProps if present (for templates)
  if (layout.defaultProps && Array.isArray(layout.defaultProps)) {
    for (let i = 0; i < layout.defaultProps.length; i++) {
      const prop = layout.defaultProps[i];

      if (!prop.type) {
        errors.push(`Default prop ${i} is missing type property`);
      }

      if (typeof prop.gridX !== 'number' || typeof prop.gridY !== 'number') {
        errors.push(`Default prop ${i} has invalid grid coordinates`);
      } else {
        // Check prop is within bounds
        if (prop.gridX < 0 || prop.gridX >= layout.width) {
          errors.push(`Default prop ${i} gridX (${prop.gridX}) is out of bounds`);
        }
        if (prop.gridY < 0 || prop.gridY >= layout.height) {
          errors.push(`Default prop ${i} gridY (${prop.gridY}) is out of bounds`);
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Extract unique tile types from a layout
 * Useful for determining which tiles need to be generated
 *
 * @param {Object} layout - Room layout object
 * @returns {string[]} Sorted array of unique tile type strings (excludes 'empty')
 */
export function getUniqueTileTypes(layout) {
  if (!layout || !layout.tiles) {
    return [];
  }

  const typeSet = new Set();

  // Flatten and collect all tile types
  for (const row of layout.tiles) {
    if (!Array.isArray(row)) continue;

    for (const tile of row) {
      if (typeof tile === 'string' && tile !== 'empty') {
        typeSet.add(tile);
      }
    }
  }

  // Convert to array and sort alphabetically
  return Array.from(typeSet).sort();
}

/**
 * Get tile metadata by type string
 *
 * @param {string} tileType - Tile type string
 * @returns {Object|null} Tile metadata or null if not found
 */
export function getTileMetadata(tileType) {
  return TILE_TYPES[tileType] || null;
}

/**
 * Check if a position in the layout is a floor tile
 *
 * @param {Object} layout - Room layout object
 * @param {number} x - X coordinate (column)
 * @param {number} y - Y coordinate (row)
 * @returns {boolean} True if position is a floor tile
 */
export function isFloorTile(layout, x, y) {
  if (!layout || !layout.tiles) return false;
  if (y < 0 || y >= layout.tiles.length) return false;
  if (x < 0 || x >= layout.tiles[y].length) return false;

  const tile = layout.tiles[y][x];
  const metadata = TILE_TYPES[tile];

  return metadata && metadata.category === 'floor';
}

/**
 * Get all floor positions in a layout
 * Useful for placing props or characters
 *
 * @param {Object} layout - Room layout object
 * @returns {Array<{x: number, y: number}>} Array of floor tile positions
 */
export function getFloorPositions(layout) {
  const positions = [];

  if (!layout || !layout.tiles) return positions;

  for (let y = 0; y < layout.tiles.length; y++) {
    const row = layout.tiles[y];
    if (!Array.isArray(row)) continue;

    for (let x = 0; x < row.length; x++) {
      if (isFloorTile(layout, x, y)) {
        positions.push({ x, y });
      }
    }
  }

  return positions;
}

/**
 * Clone a layout object (deep copy)
 *
 * @param {Object} layout - Layout to clone
 * @returns {Object} Deep copy of the layout
 */
export function cloneLayout(layout) {
  if (!layout) return null;

  return {
    name: layout.name,
    width: layout.width,
    height: layout.height,
    tiles: layout.tiles ? layout.tiles.map(row => [...row]) : [],
    props: layout.props ? layout.props.map(prop => ({ ...prop })) : [],
    defaultProps: layout.defaultProps ? layout.defaultProps.map(prop => ({ ...prop })) : undefined
  };
}
