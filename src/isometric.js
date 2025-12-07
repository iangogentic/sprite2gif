/**
 * Isometric Coordinate Conversion Utilities
 *
 * This module provides functions for converting between grid coordinates
 * and screen coordinates in isometric projection, plus related utilities.
 *
 * Standard isometric projection uses a 2:1 ratio (tileWidth:tileHeight = 64:32).
 *
 * Coordinate system:
 * - Grid: (gridX, gridY) where X is column, Y is row
 * - Screen: (x, y) in pixels
 *
 * In isometric projection:
 * - X axis goes down-right (positive gridX increases screenX and screenY)
 * - Y axis goes down-left (positive gridY decreases screenX, increases screenY)
 */

/**
 * Convert grid coordinates to isometric screen coordinates
 *
 * In isometric projection:
 * - X axis goes down-right
 * - Y axis goes down-left
 *
 * @param {number} gridX - Grid X position (column)
 * @param {number} gridY - Grid Y position (row)
 * @param {number} tileWidth - Tile width in pixels (default: 64)
 * @param {number} tileHeight - Tile height in pixels (default: 32)
 * @returns {Object} { x, y } screen coordinates in pixels
 */
export function gridToScreen(gridX, gridY, tileWidth = 64, tileHeight = 32) {
  return {
    x: (gridX - gridY) * (tileWidth / 2),
    y: (gridX + gridY) * (tileHeight / 2)
  };
}

/**
 * Convert screen coordinates to grid coordinates
 *
 * @param {number} screenX - Screen X position in pixels
 * @param {number} screenY - Screen Y position in pixels
 * @param {number} tileWidth - Tile width in pixels (default: 64)
 * @param {number} tileHeight - Tile height in pixels (default: 32)
 * @returns {Object} { gridX, gridY } grid coordinates (may be floats, use Math.floor for tile lookup)
 */
export function screenToGrid(screenX, screenY, tileWidth = 64, tileHeight = 32) {
  const halfWidth = tileWidth / 2;
  const halfHeight = tileHeight / 2;

  return {
    gridX: (screenX / halfWidth + screenY / halfHeight) / 2,
    gridY: (screenY / halfHeight - screenX / halfWidth) / 2
  };
}

/**
 * Convert screen coordinates to grid coordinates, rounded to nearest tile
 *
 * @param {number} screenX - Screen X position in pixels
 * @param {number} screenY - Screen Y position in pixels
 * @param {number} tileWidth - Tile width in pixels (default: 64)
 * @param {number} tileHeight - Tile height in pixels (default: 32)
 * @returns {Object} { gridX, gridY } integer grid coordinates
 */
export function screenToGridRounded(screenX, screenY, tileWidth = 64, tileHeight = 32) {
  const { gridX, gridY } = screenToGrid(screenX, screenY, tileWidth, tileHeight);
  return {
    gridX: Math.floor(gridX),
    gridY: Math.floor(gridY)
  };
}

/**
 * Calculate bounding box for a room in screen space
 *
 * An isometric room forms a diamond shape on screen.
 * This returns the screen-space bounding box.
 *
 * @param {number} roomWidth - Room width in tiles
 * @param {number} roomHeight - Room height in tiles
 * @param {number} tileWidth - Tile width in pixels (default: 64)
 * @param {number} tileHeight - Tile height in pixels (default: 32)
 * @returns {Object} { width, height, offsetX, offsetY }
 */
export function calculateRoomBounds(roomWidth, roomHeight, tileWidth = 64, tileHeight = 32) {
  // Calculate corners in screen space
  const topLeft = gridToScreen(0, 0, tileWidth, tileHeight);
  const topRight = gridToScreen(roomWidth - 1, 0, tileWidth, tileHeight);
  const bottomLeft = gridToScreen(0, roomHeight - 1, tileWidth, tileHeight);
  const bottomRight = gridToScreen(roomWidth - 1, roomHeight - 1, tileWidth, tileHeight);

  // Find bounds
  const minX = Math.min(topLeft.x, bottomLeft.x);
  const maxX = Math.max(topRight.x, bottomRight.x) + tileWidth;
  const minY = Math.min(topLeft.y, topRight.y);
  const maxY = Math.max(bottomLeft.y, bottomRight.y) + tileHeight;

  return {
    width: maxX - minX,
    height: maxY - minY,
    offsetX: -minX,  // Offset to make top-left corner at (0, 0)
    offsetY: -minY
  };
}

/**
 * Get the center point of a tile in screen coordinates
 *
 * @param {number} gridX - Grid X position
 * @param {number} gridY - Grid Y position
 * @param {number} tileWidth - Tile width in pixels (default: 64)
 * @param {number} tileHeight - Tile height in pixels (default: 32)
 * @returns {Object} { x, y } center point in screen coordinates
 */
export function getTileCenter(gridX, gridY, tileWidth = 64, tileHeight = 32) {
  const topLeft = gridToScreen(gridX, gridY, tileWidth, tileHeight);
  return {
    x: topLeft.x + tileWidth / 2,
    y: topLeft.y + tileHeight / 2
  };
}

/**
 * Check if a screen point is inside a specific tile
 *
 * For isometric tiles, this checks if the point is inside
 * the diamond-shaped tile area.
 *
 * @param {number} screenX - Screen X position
 * @param {number} screenY - Screen Y position
 * @param {number} gridX - Tile grid X
 * @param {number} gridY - Tile grid Y
 * @param {number} tileWidth - Tile width (default: 64)
 * @param {number} tileHeight - Tile height (default: 32)
 * @returns {boolean} True if point is inside tile
 */
export function isPointInTile(screenX, screenY, gridX, gridY, tileWidth = 64, tileHeight = 32) {
  const tilePos = gridToScreen(gridX, gridY, tileWidth, tileHeight);

  // Translate point to tile-local coordinates
  const localX = screenX - tilePos.x - tileWidth / 2;
  const localY = screenY - tilePos.y - tileHeight / 2;

  // Check if inside diamond (using Manhattan distance in tile space)
  const normalizedX = Math.abs(localX) / (tileWidth / 2);
  const normalizedY = Math.abs(localY) / (tileHeight / 2);

  return (normalizedX + normalizedY) <= 1;
}
