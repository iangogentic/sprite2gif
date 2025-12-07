# Task: Project System

> **Status:** PLANNED
> **Priority:** High
> **Depends On:** None

---

## Goal

Create a project configuration system that stores style references in a `.sprite2gif/` folder. When generating assets, these references are automatically injected to ensure visual consistency across all generated assets.

---

## Current State

Every generation requires manually specifying `--reference <image>`:
```bash
node src/index.js generate "cat idle" --reference ~/Downloads/cat.png -o idle.apng
node src/index.js generate "cat walk" --reference ~/Downloads/cat.png -o walk.apng
node src/index.js generate "cat typing" --reference ~/Downloads/cat.png -o typing.apng
```

This is tedious and error-prone.

---

## Proposed Solution

Store references in a project folder:
```
my-game/
├── .sprite2gif/
│   ├── config.json
│   └── style-references/
│       └── main-cat.png
├── assets/
└── ...
```

Then generation is automatic:
```bash
cd my-game
sprite2gif generate "cat idle" -o assets/idle.apng  # auto-injects main-cat.png
```

---

## Implementation

### 1. Create `src/project.js`

```javascript
import fs from 'fs/promises';
import path from 'path';

const PROJECT_DIR = '.sprite2gif';
const CONFIG_FILE = 'config.json';
const REFERENCES_DIR = 'style-references';

/**
 * Find project root by searching for .sprite2gif/ folder
 * @param {string} startDir - Directory to start searching from
 * @returns {Promise<string|null>} - Project root path or null
 */
export async function findProjectRoot(startDir = process.cwd()) {
  let current = startDir;

  while (current !== path.dirname(current)) {
    const projectPath = path.join(current, PROJECT_DIR);
    try {
      const stat = await fs.stat(projectPath);
      if (stat.isDirectory()) {
        return current;
      }
    } catch {
      // Not found, continue searching
    }
    current = path.dirname(current);
  }

  return null;
}

/**
 * Load project configuration
 * @returns {Promise<Object|null>} - Config object or null if not in project
 */
export async function loadProjectConfig() {
  const root = await findProjectRoot();
  if (!root) return null;

  const configPath = path.join(root, PROJECT_DIR, CONFIG_FILE);
  try {
    const content = await fs.readFile(configPath, 'utf8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Save project configuration
 * @param {Object} config - Configuration to save
 */
export async function saveProjectConfig(config) {
  const root = await findProjectRoot();
  if (!root) throw new Error('Not in a sprite2gif project');

  const configPath = path.join(root, PROJECT_DIR, CONFIG_FILE);
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
}

/**
 * Initialize a new project
 * @param {string} name - Project name
 */
export async function initProject(name = path.basename(process.cwd())) {
  const projectPath = path.join(process.cwd(), PROJECT_DIR);
  const referencesPath = path.join(projectPath, REFERENCES_DIR);

  await fs.mkdir(projectPath, { recursive: true });
  await fs.mkdir(referencesPath, { recursive: true });

  const config = {
    version: '1.0.0',
    name,
    defaultStyle: 'isometric pixel art',
    styleReferences: [],
    autoInject: true
  };

  await fs.writeFile(
    path.join(projectPath, CONFIG_FILE),
    JSON.stringify(config, null, 2)
  );

  return projectPath;
}

/**
 * Add a style reference image
 * @param {string} imagePath - Path to image file
 * @param {string} name - Optional name for reference
 * @param {string} description - Optional description
 */
export async function addStyleReference(imagePath, name, description = '') {
  const config = await loadProjectConfig();
  if (!config) throw new Error('Not in a sprite2gif project');

  const root = await findProjectRoot();
  const referencesDir = path.join(root, PROJECT_DIR, REFERENCES_DIR);

  // Generate name from filename if not provided
  const fileName = path.basename(imagePath);
  const refName = name || path.parse(fileName).name;

  // Copy image to references folder
  const destPath = path.join(referencesDir, fileName);
  await fs.copyFile(imagePath, destPath);

  // Update config
  const relativePath = path.join(REFERENCES_DIR, fileName);
  config.styleReferences.push({
    name: refName,
    path: relativePath,
    description
  });

  await saveProjectConfig(config);

  return { name: refName, path: relativePath };
}

/**
 * Remove a style reference
 * @param {string} name - Reference name to remove
 */
export async function removeStyleReference(name) {
  const config = await loadProjectConfig();
  if (!config) throw new Error('Not in a sprite2gif project');

  const root = await findProjectRoot();
  const ref = config.styleReferences.find(r => r.name === name);

  if (!ref) throw new Error(`Reference "${name}" not found`);

  // Delete file
  const filePath = path.join(root, PROJECT_DIR, ref.path);
  await fs.unlink(filePath);

  // Update config
  config.styleReferences = config.styleReferences.filter(r => r.name !== name);
  await saveProjectConfig(config);
}

/**
 * List all style references
 * @returns {Promise<Array>} - Array of reference objects
 */
export async function listStyleReferences() {
  const config = await loadProjectConfig();
  if (!config) return [];

  return config.styleReferences;
}

/**
 * Get all reference image buffers for injection
 * @returns {Promise<Array>} - Array of { buffer, mimeType, name }
 */
export async function getStyleReferenceBuffers() {
  const config = await loadProjectConfig();
  if (!config || !config.autoInject) return [];

  const root = await findProjectRoot();
  const results = [];

  for (const ref of config.styleReferences) {
    const fullPath = path.join(root, PROJECT_DIR, ref.path);
    const buffer = await fs.readFile(fullPath);
    const ext = path.extname(ref.path).toLowerCase();
    const mimeType = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp'
    }[ext] || 'image/png';

    results.push({ buffer, mimeType, name: ref.name });
  }

  return results;
}
```

### 2. Add CLI Commands in index.js

```javascript
import {
  initProject,
  addStyleReference,
  removeStyleReference,
  listStyleReferences,
  loadProjectConfig
} from './project.js';

// Initialize project
program
  .command('init [name]')
  .description('Initialize a new sprite2gif project')
  .action(async (name) => {
    const projectPath = await initProject(name);
    console.log(`Initialized sprite2gif project at ${projectPath}`);
    console.log('\nNext steps:');
    console.log('  sprite2gif add-style <image>  Add a style reference');
    console.log('  sprite2gif generate "..."     Generate with auto-injected references');
  });

// Add style reference
program
  .command('add-style <image>')
  .description('Add a style reference image')
  .option('--name <name>', 'Name for this reference')
  .option('--description <desc>', 'Description of the reference')
  .action(async (image, options) => {
    const ref = await addStyleReference(image, options.name, options.description);
    console.log(`Added style reference: ${ref.name}`);
  });

// List style references
program
  .command('list-styles')
  .description('List all style references')
  .action(async () => {
    const refs = await listStyleReferences();
    if (refs.length === 0) {
      console.log('No style references configured.');
      console.log('Use: sprite2gif add-style <image>');
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
  });

// Remove style reference
program
  .command('remove-style <name>')
  .description('Remove a style reference')
  .action(async (name) => {
    await removeStyleReference(name);
    console.log(`Removed style reference: ${name}`);
  });
```

### 3. Update generator.js to Auto-Inject

```javascript
import { getStyleReferenceBuffers } from './project.js';

async function buildContentsWithProjectRefs(contents, skipProject = false) {
  if (skipProject) return contents;

  const refs = await getStyleReferenceBuffers();
  if (refs.length === 0) return contents;

  // Prepend style references to contents
  const injectedContents = [];
  for (const ref of refs) {
    injectedContents.push({
      inlineData: {
        mimeType: ref.mimeType,
        data: ref.buffer.toString('base64')
      }
    });
  }

  return [...injectedContents, ...contents];
}

// In generateSpriteSheet:
export async function generateSpriteSheet(description, options = {}) {
  const { referenceImage, skipProject = false, ...rest } = options;

  let contents = [];

  // Add explicit reference image first (if provided)
  if (referenceImage) {
    const imageBuffer = await fs.readFile(referenceImage);
    contents.push({
      inlineData: {
        mimeType: getMimeType(referenceImage),
        data: imageBuffer.toString('base64')
      }
    });
  }

  // Inject project style references
  contents = await buildContentsWithProjectRefs(contents, skipProject);

  // ... rest of function
}
```

### 4. Add --no-project Flag

```javascript
program
  .command('generate <description>')
  // ... existing options
  .option('--no-project', 'Skip auto-injection of project style references')
  .action(async (description, options) => {
    // Pass skipProject to generation functions
    await generateWorkflow(description, {
      ...options,
      skipProject: !options.project // --no-project sets project=false
    });
  });
```

---

## CLI Examples

```bash
# Initialize project
cd my-game
sprite2gif init "my-game"
# Creates .sprite2gif/ folder

# Add style references
sprite2gif add-style ~/Downloads/main-cat.png --name "main-cat" --description "Primary character"
sprite2gif add-style ~/Downloads/office-style.png --name "office-style"

# List references
sprite2gif list-styles
# Output:
# Style References:
#   main-cat
#     Path: style-references/main-cat.png
#     Description: Primary character
#   office-style
#     Path: style-references/office-style.png

# Generate with auto-injection
sprite2gif generate "cat typing animation" -o typing.apng
# Automatically includes main-cat.png and office-style.png

# Generate without project references
sprite2gif generate "robot walking" --no-project -o robot.apng

# Remove a reference
sprite2gif remove-style office-style
```

---

## Config Schema

```json
{
  "version": "1.0.0",
  "name": "my-game",
  "defaultStyle": "isometric pixel art",
  "styleReferences": [
    {
      "name": "main-cat",
      "path": "style-references/main-cat.png",
      "description": "Primary character reference"
    },
    {
      "name": "office-style",
      "path": "style-references/office-style.png",
      "description": "Office environment reference"
    }
  ],
  "autoInject": true
}
```

---

## Testing

### Test 1: Init
```bash
cd /tmp && mkdir test-project && cd test-project
sprite2gif init
ls -la .sprite2gif/
# Should see config.json and style-references/
```

### Test 2: Add Reference
```bash
sprite2gif add-style ~/Downloads/cat.png --name "test-cat"
cat .sprite2gif/config.json
# Should show test-cat in styleReferences
ls .sprite2gif/style-references/
# Should show cat.png
```

### Test 3: Auto-Injection
```bash
sprite2gif generate "cat idle" -o test.apng -v
# Verbose should show "Injecting 1 project reference(s)"
```

---

## Success Criteria

- [ ] `sprite2gif init` creates `.sprite2gif/` with valid config
- [ ] `sprite2gif add-style` copies image and updates config
- [ ] `sprite2gif list-styles` shows all references
- [ ] `sprite2gif remove-style` removes image and config entry
- [ ] Style references auto-inject into `generate` command
- [ ] Style references auto-inject into `static` command
- [ ] `--no-project` flag skips auto-injection
- [ ] Project root detection works from subdirectories
