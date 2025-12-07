import fs from 'fs/promises';
import path from 'path';

const PROJECT_DIR = '.sprite2gif';
const CONFIG_FILE = 'config.json';
const REFERENCES_DIR = 'style-references';

/**
 * Get MIME type from file extension
 * @param {string} filePath - Path to the file
 * @returns {string} MIME type string
 */
function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp'
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

/**
 * Find project root by searching for .sprite2gif/ folder
 * Walks up directory tree from startDir
 * @param {string} startDir - Directory to start searching from
 * @returns {Promise<string|null>} Project root path or null if not found
 */
export async function findProjectRoot(startDir = process.cwd()) {
  let currentDir = path.resolve(startDir);
  const root = path.parse(currentDir).root;

  while (currentDir !== root) {
    const projectPath = path.join(currentDir, PROJECT_DIR);
    try {
      const stat = await fs.stat(projectPath);
      if (stat.isDirectory()) {
        return currentDir;
      }
    } catch {
      // Directory doesn't exist, continue searching up
    }
    currentDir = path.dirname(currentDir);
  }

  // Check root directory as well
  const rootProjectPath = path.join(root, PROJECT_DIR);
  try {
    const stat = await fs.stat(rootProjectPath);
    if (stat.isDirectory()) {
      return root;
    }
  } catch {
    // Not found in root either
  }

  return null;
}

/**
 * Load project configuration
 * @returns {Promise<object|null>} Config object or null if not in project
 */
export async function loadProjectConfig() {
  const projectRoot = await findProjectRoot();
  if (!projectRoot) {
    return null;
  }

  const configPath = path.join(projectRoot, PROJECT_DIR, CONFIG_FILE);
  try {
    const content = await fs.readFile(configPath, 'utf-8');
    const config = JSON.parse(content);
    // Attach project root for convenience
    config._projectRoot = projectRoot;
    return config;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw new Error(`Failed to load project config: ${error.message}`);
  }
}

/**
 * Save project configuration
 * @param {object} config - Configuration object to save
 * @returns {Promise<void>}
 */
export async function saveProjectConfig(config) {
  const projectRoot = await findProjectRoot();
  if (!projectRoot) {
    throw new Error('Not in a sprite2gif project. Run "sprite2gif init" first.');
  }

  // Remove internal properties before saving
  const configToSave = { ...config };
  delete configToSave._projectRoot;

  const configPath = path.join(projectRoot, PROJECT_DIR, CONFIG_FILE);
  await fs.writeFile(configPath, JSON.stringify(configToSave, null, 2), 'utf-8');
}

/**
 * Initialize a new project in current directory
 * Creates .sprite2gif/ folder with config.json and style-references/
 * @param {string} name - Optional project name (defaults to folder name)
 * @returns {Promise<object>} The created configuration object
 */
export async function initProject(name) {
  const cwd = process.cwd();
  const projectDir = path.join(cwd, PROJECT_DIR);
  const referencesDir = path.join(projectDir, REFERENCES_DIR);
  const configPath = path.join(projectDir, CONFIG_FILE);

  // Check if already initialized
  try {
    await fs.stat(projectDir);
    throw new Error(`Project already initialized in ${cwd}`);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  // Create directories
  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(referencesDir, { recursive: true });

  // Create default config
  const projectName = name || path.basename(cwd);
  const config = {
    version: '1.0.0',
    name: projectName,
    defaultStyle: 'isometric pixel art',
    styleReferences: [],
    autoInject: true
  };

  await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');

  return projectDir;
}

/**
 * Add a style reference image
 * Copies image to .sprite2gif/style-references/ and updates config
 * @param {string} imagePath - Path to the image file to add
 * @param {string} name - Name for this style reference
 * @param {string} description - Optional description
 * @returns {Promise<object>} The added reference entry
 */
export async function addStyleReference(imagePath, name, description = '') {
  const projectRoot = await findProjectRoot();
  if (!projectRoot) {
    throw new Error('Not in a sprite2gif project. Run "sprite2gif init" first.');
  }

  // Validate image exists
  try {
    await fs.stat(imagePath);
  } catch {
    throw new Error(`Image file not found: ${imagePath}`);
  }

  // Validate MIME type
  const mimeType = getMimeType(imagePath);
  if (!mimeType.startsWith('image/')) {
    throw new Error(`File does not appear to be an image: ${imagePath}`);
  }

  const config = await loadProjectConfig();

  // Check for duplicate name
  if (config.styleReferences.some(ref => ref.name === name)) {
    throw new Error(`Style reference with name "${name}" already exists`);
  }

  // Copy image to references directory
  const ext = path.extname(imagePath);
  const destFilename = `${name}${ext}`;
  const destPath = path.join(projectRoot, PROJECT_DIR, REFERENCES_DIR, destFilename);

  await fs.copyFile(imagePath, destPath);

  // Update config
  const reference = {
    name,
    path: destFilename,
    description
  };
  config.styleReferences.push(reference);
  await saveProjectConfig(config);

  return reference;
}

/**
 * Remove a style reference by name
 * Deletes the image file and removes entry from config
 * @param {string} name - Name of the style reference to remove
 * @returns {Promise<void>}
 */
export async function removeStyleReference(name) {
  const projectRoot = await findProjectRoot();
  if (!projectRoot) {
    throw new Error('Not in a sprite2gif project. Run "sprite2gif init" first.');
  }

  const config = await loadProjectConfig();
  const refIndex = config.styleReferences.findIndex(ref => ref.name === name);

  if (refIndex === -1) {
    throw new Error(`Style reference "${name}" not found`);
  }

  const reference = config.styleReferences[refIndex];
  const imagePath = path.join(projectRoot, PROJECT_DIR, REFERENCES_DIR, reference.path);

  // Delete the image file
  try {
    await fs.unlink(imagePath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new Error(`Failed to delete reference image: ${error.message}`);
    }
    // File already gone, continue with config update
  }

  // Update config
  config.styleReferences.splice(refIndex, 1);
  await saveProjectConfig(config);
}

/**
 * List all style references
 * @returns {Promise<Array<{name: string, path: string, description: string}>>}
 */
export async function listStyleReferences() {
  const config = await loadProjectConfig();
  if (!config) {
    return [];
  }
  return config.styleReferences || [];
}

/**
 * Get all reference image buffers for injection into AI generation
 * @returns {Promise<Array<{buffer: Buffer, mimeType: string, name: string}>>}
 *          Empty array if not in project or autoInject is false
 */
export async function getStyleReferenceBuffers() {
  const config = await loadProjectConfig();

  if (!config) {
    return [];
  }

  if (!config.autoInject) {
    return [];
  }

  if (!config.styleReferences || config.styleReferences.length === 0) {
    return [];
  }

  const projectRoot = config._projectRoot;
  const buffers = [];

  for (const ref of config.styleReferences) {
    const imagePath = path.join(projectRoot, PROJECT_DIR, REFERENCES_DIR, ref.path);
    try {
      const buffer = await fs.readFile(imagePath);
      const mimeType = getMimeType(ref.path);
      buffers.push({
        buffer,
        mimeType,
        name: ref.name
      });
    } catch (error) {
      // Skip missing files but log warning
      console.warn(`Warning: Style reference "${ref.name}" not found at ${imagePath}`);
    }
  }

  return buffers;
}
