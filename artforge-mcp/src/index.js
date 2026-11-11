'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { toolPaths } = require('./engine/paths');
const { ReferenceLibrary } = require('./engine/references');
const { ToolDocs } = require('./engine/tool-docs');
const { ToolBridge } = require('./engine/bridge');
const { Pipeline } = require('./engine/pipeline');
const { listSkills } = require('./engine/skills');
const { buildPlan } = require('./engine/router');
const { buildReferenceIndex } = require('./engine/index-builder');
const { BookKnowledge } = require('./engine/knowledge');
const { createLogger } = require('./engine/log');
const { GenerativeImageAdapter } = require('./engine/generative-image-adapter');

/**
 * ArtForge AI MCP engine: the three components wired together.
 *   ① indexing / skills / routing   (router + skills + tool docs)
 *   ② references                   (ReferenceLibrary over the preserved folders)
 *   ③ the drawing tool             (ToolBridge over its real HTTP API)
 */
function createMcpEngine(options) {
  const opts = options || {};
  const projectRoot = path.resolve(opts.projectRoot || path.join(__dirname, '..', '..'));
  const paths = toolPaths(projectRoot);
  const dataDir = path.resolve(opts.dataDir || path.join(__dirname, '..', 'data'));
  const stateDir = path.join(dataDir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });

  const logDir = path.resolve(opts.logDir || process.env.ARTFORGE_LOG_DIR || path.join(projectRoot, 'logs'));
  const logger = opts.logger || createLogger('mcp', { dir: logDir });

  const library = new ReferenceLibrary(path.join(dataDir, 'references.index.json'));
  const knowledge = new BookKnowledge({
    indexPath: path.resolve(opts.bookIndexPath || paths.bookIndexPath),
    booksDir: path.resolve(opts.bookIndexBooksDir || paths.bookIndexBooksDir),
  });
  const docs = new ToolDocs(paths.docsDir, { opsSource: paths.drawingToolOpsSource });
  const bridge = new ToolBridge({
    baseUrl: opts.toolUrl || process.env.ARTFORGE_TOOL_URL || 'http://127.0.0.1:4173',
    entryPath: paths.drawingToolEntry,
    autoStart: opts.autoStart,
    logger: createLogger('bridge', { dir: logDir }),
  });
  const generativeImages = new GenerativeImageAdapter(Object.assign({}, opts.generativeImages || {}, {
    validatePng: require('./engine/png-contract').validatePng,
  }));
  const artifacts = new (require('./engine/artifact-store').ArtifactStore)({dir:path.join(dataDir,'artifacts'),allowedRoots:opts.artifactRoots || [path.join(projectRoot,'outputs'),path.join(projectRoot,'dev-runtime'),path.join(paths.drawingTool,'data','exports')]});
  const pipeline = new Pipeline({ bridge, docs, library, stateDir, knowledge, logger });

  return {
    projectRoot,
    paths,
    dataDir,
    stateDir,
    logDir,
    logger,
    library,
    knowledge,
    docs,
    bridge,
    pipeline,
    generativeImages,
    artifacts,
    featureStatus: require('./engine/features').status,
    previewGeneratedImage: image => require('./engine/generated-preview').generatedPreview(image, require('./engine/paths').loadCanvasModule(paths.drawingTool)),
    skills: listSkills(),
    plan: (input) => buildPlan(input, { library, knowledge }),
    /** Like plan(), but first analyses a user reference image (colours + composition) with the drawing tool. */
    planAsync: async (input) => {
      const args = Object.assign({}, input);
      if (args.referenceImage && !args.referenceAnalysis) {
        const analysed = await bridge.call('image.analyze', { path: args.referenceImage });
        args.referenceAnalysis = analysed.data;
      }
      return buildPlan(args, { library, knowledge });
    },
    buildIndex: (indexOptions) => buildReferenceIndex(paths, indexOptions),
    indexPath: path.join(dataDir, 'references.index.json'),
  };
}

module.exports = { createMcpEngine };
