# ArtForge documentation

| File | Topic |
|---|---|
| [04-operations.md](04-operations.md) | Document, layer, drawing, text, export and HTTP operations |
| [05-ui-tools.md](05-ui-tools.md) | Editor UI tools |
| [06-arabic-fonts.md](06-arabic-fonts.md) | Arabic shaping and bundled fonts |
| [07-save-export.md](07-save-export.md) | Saving and exporting |
| [08-animation.md](08-animation.md) | Animation timeline |
| [09-examples.md](09-examples.md) | Worked examples |
| [10-errors.md](10-errors.md) | Error codes |
| [11-limits.md](11-limits.md) | Known limits |
| [12-verification.md](12-verification.md) | Verification history of the full engine |
| [trial-deployment.md](trial-deployment.md) | Docker / hosted deployment of this server (Arabic) |

## Scope of this repository

These documents describe the complete ArtForge engine. This repository ships the engine sources, the MCP
server (`server.js`) and the bundled fonts. It does **not** include the engine's command-line launchers
(`bin/artforge-draw.js`, `bin/artforge-mcp.js`), its internal test suites (`tests/`), helper scripts
(`tools/`, `qa/`) or the chapters 01–03. Commands in these documents that use those paths do not apply here.

In this repository use:

```sh
npm run setup   # install the drawing-engine dependency
npm start       # MCP over HTTP at http://127.0.0.1:4273/mcp
npm test        # end-to-end smoke test
```

When reached through `server.js`, operations are limited to the `draw.*` primitives, `batch`,
`document.info`, `document.preview`, `generation.status`, design planning, and PNG / JPEG / WebP export.
Operations such as `font.list`, image import, PDF / PSD / SVG export and project bundles are not available.
