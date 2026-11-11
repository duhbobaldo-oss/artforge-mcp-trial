# Third-Party Notices

ArtForge AI MCP is licensed under the [Apache License 2.0](LICENSE). It includes or depends on the
third-party components listed below, each under its own license. Their license texts are kept with the
components and must be preserved in redistributions.

## Bundled fonts (`drawing-tool/fonts/`)

All bundled fonts are licensed under the **SIL Open Font License, Version 1.1** (OFL-1.1). The full license
text and copyright notice for each family are in `drawing-tool/fonts/licenses/`. Under the OFL the fonts may be
used, bundled and redistributed with this software; they may not be sold on their own, and modified versions
must not use the Reserved Font Names.

| Font files | Copyright | License file |
|---|---|---|
| `Amiri-Regular.ttf`, `Amiri-Bold.ttf` | Copyright 2010-2022 The Amiri Project Authors (https://github.com/aliftype/amiri) | `drawing-tool/fonts/licenses/Amiri-OFL.txt` |
| `Tajawal-Regular.ttf`, `Tajawal-Bold.ttf` | Copyright 2018 Boutros International (http://www.boutrosfonts.com) | `drawing-tool/fonts/licenses/Tajawal-OFL.txt` |
| `Almarai-Regular.ttf`, `Almarai-Bold.ttf` | Copyright 2019 The Almarai Project Authors (https://github.com/JuergenWillrodt/Almarai) | `drawing-tool/fonts/licenses/Almarai-OFL.txt` |

## npm dependencies (installed by `npm run setup`, not committed)

| Package | Version | License | Notes |
|---|---|---|---|
| `@napi-rs/canvas` | 0.1.80 | MIT | Node-API binding to Google Skia |
| `@napi-rs/canvas-<platform>` (one per OS/CPU, optional) | 0.1.80 | MIT | Prebuilt native binary; statically links **Skia** (BSD-3-Clause, © Google LLC) and ships ICU data `icudtl.dat` (Unicode License V3) |

The core MCP server uses Node.js built-in modules. Optional image normalization reuses the existing canvas dependency. The public gateway uses `@cloudflare/workers-oauth-provider` 1.2.4 (MIT); its npm lockfile is included.

## Docker base image

The `Dockerfile` builds on `node:24-bookworm-slim` (Node.js: MIT; Debian packages under their respective
licenses). The image is not distributed from this repository.

## Sample images

The original four images in `docs/gallery/` were rendered by the ArtForge engine and are © OBR Group, provided under the
Apache License 2.0 together with this repository.

## External links in documentation

Some skill guides in `artforge-mcp/skills/` link to public third-party pages (for example Adobe Help and
artist portfolios) as background reading. No content from those pages is redistributed here.

## Integrated hosted image model

FLUX.2 Klein 4B is supplied by Black Forest Labs through Cloudflare Workers AI. Model weights are not bundled, and provider/model terms apply separately. `neural-reading-room.png` was generated through this integration and composited with ArtForge in DEV; it is not a purely procedural drawing.
