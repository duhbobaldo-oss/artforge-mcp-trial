# ArtForge AI MCP

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-339933.svg)
![MCP](https://img.shields.io/badge/MCP-JSON--RPC%20over%20HTTP-6f42c1.svg)

**[ط§ظ„ط¹ط±ط¨ظٹط©](#ط§ظ„ط¹ط±ط¨ظٹط©) آ· [English](#english)**

<p align="center">
  <img src="docs/gallery/editorial-card.png" alt="ArtForge editorial card with Arabic headline" width="49%">
  <img src="docs/gallery/mobius-card.png" alt="ArtForge Mأ¶bius ribbon card with Arabic text" width="49%">
  <img src="docs/gallery/desert-oasis.png" alt="Desert oasis scene drawn by ArtForge" width="49%">
  <img src="docs/gallery/stone-house.png" alt="Stone cottage scene drawn by ArtForge" width="49%">
</p>
<p align="center"><sub>Sample works rendered by the ArtForge engine آ· ظ†ظ…ط§ط°ط¬ ظ…ظ† ط£ط¹ظ…ط§ظ„ ط§ظ„ظ…ظƒظˆظ‘ظ†</sub></p>


## ظ…ظˆظ„ظ‘ط¯ ط§ظ„طµظˆط± ط§ظ„ظ…ط¯ظ…ط¬ آ· Integrated image generator

**ArtForge ظٹطھط¶ظ…ظ† ظ…ظˆظ„ظ‘ط¯ طµظˆط± ط¹طµط¨ظٹظ‹ط§ ظ…ط¯ظ…ط¬ظ‹ط§ ظٹط³طھط®ط¯ظ… FLUX.2 Klein 4B ظ…ظ† Black Forest LabsطŒ ظˆظٹط´ط؛ظ‘ظ„ظ‡ Cloudflare Workers AI.** ط§ظ„ظ…ظˆظ„ط¯ ظ„ظٹط³ ظ†ظ…ظˆط°ط¬ظ‹ط§ ظ…ط¯ط±ظ‘ط¨ظ‹ط§ ظ…ظ† ط§ظ„طµظپط± ط¨ظˆط§ط³ط·ط© OBR ظˆظ„ط§ ظٹط¹ظ…ظ„ ط¹ظ„ظ‰ GPU ط®ط§ط¯ظ… Renderط› ظٹط­ط§ظپط¸ ArtForge ط¹ظ„ظ‰ ظ…ط­ط±ظƒ Skia ظˆط§ظ„ظ‚ظˆط§ظ„ط¨ ظˆط§ظ„ط®ط·ظˆط· ط§ظ„ط¹ط±ط¨ظٹط© ظˆظ…ط³ط§ط± ط§ظ„طھط­ط±ظٹط± ط§ظ„ظ‚ط§ط¦ظ….

The integrated generator uses **FLUX.2 Klein 4B**, hosted by **Cloudflare Workers AI**. The public MCP gateway exposes `artforge_generate_image` with asynchronous submit/get/cancel/delete actions, durable idempotency and connection-scoped ownership. It runs independently of Render cold starts.

- ط§ظ„ط±ط§ط¨ط· ط§ظ„ط¹ط§ظ… / Public MCP: `https://artforge-mcp-gateway.obr432.workers.dev/mcp`.
- ط§ظ„ظ…ط³ط§ط± ط§ظ„ط¹ط§ظ…: طµظˆط± ظ†ظ‚ط·ظٹط© 256â€“512pxطŒ ط­طھظ‰ 3 ط·ظ„ط¨ط§طھ ظ„ظƒظ„ ط§طھطµط§ظ„ ظپظٹ ط§ظ„ظٹظˆظ… UTCطŒ ظˆط­طµط© ظٹظˆظ…ظٹط© ظ…ط´طھط±ظƒط© ظ…ظ‚ط¯ط±ط© ظ„ط§ طھطھط¬ط§ظˆط² 900 Neurons. ظ„ط§ ط¥ط¹ط§ط¯ط© طھظ„ظ‚ط§ط¦ظٹط© ظ„ظ„طھظˆظ„ظٹط¯ط› طھظ†طھظ‡ظٹ ط§ظ„طµظˆط± ط§ظ„ظ…ط­ظپظˆط¸ط© ط¨ط¹ط¯ 24 ط³ط§ط¹ط©.
- Public output is raster, not editable vectors. Exact editable Arabic overlays and saved projects are verified in the separate DEV integration; the public generator returns a standalone image in the chat.
- ظ„ظ„ط§ط·ظ„ط§ط¹ ط¹ظ„ظ‰ ط§ظ„طھظ†ظپظٹط°: [public gateway and quotas](cloudflare-gateway/src/image-generation.js)طŒ [DEV integration](docs/CLOUDFLARE-GENERATION-DEV.md). Optional DEV generation requires Node.js 24; the basic renderer remains compatible with Node.js 20+.
- Owner-managed local installation: optional `artforge-mcp/data/owner-generation.json` enables the existing `artforge_tool_op` operation `generation.generate` using Wrangler OAuth stored by Cloudflare. This local path uses a separate persistent 900-Neuron daily reservation cap, requires Node.js 24, and never accepts credentials or provider URLs from an MCP request. See [owner configuration](docs/OWNER-GENERATION.md).
- Model weights are not included. Cloudflare service terms and model terms apply separately from the repository's Apache-2.0 code license.

---

<div dir="rtl" align="right">

## ط§ظ„ط¹ط±ط¨ظٹط©

**ArtForge AI MCP** ظ…ط­ط±ظ‘ظƒ ط±ط³ظ… ظˆطھطµظ…ظٹظ… ط«ظ†ط§ط¦ظٹ ط§ظ„ط£ط¨ط¹ط§ط¯ ظ…ظپطھظˆط­ ط§ظ„ظ…طµط¯ط±طŒ طµظڈظ…ظ‘ظ… ظ„ظ„ط¹ط±ط¨ظٹط© ط£ظˆظ„ظ‹ط§طŒ ظˆظٹظڈطھط§ط­ ظ„ظˆظƒظ„ط§ط، ط§ظ„ط°ظƒط§ط، ط§ظ„ط§طµط·ظ†ط§ط¹ظٹ ط¹ط¨ط± ط¨ط±ظˆطھظˆظƒظˆظ„ MCP. ظ…ط´ط±ظˆط¹ ظ…ظ† **ظ…ط¬ظ…ظˆط¹ط© OBR Group ط§ظ„ط±ظ‚ظ…ظٹط©**.

### ظ„ظ…ط§ط°ط§ ArtForgeطں

- **ط¯ط¹ظ… ط£طµظٹظ„ ظ„ظ„ط؛ط© ط§ظ„ط¹ط±ط¨ظٹط©**: طھط´ظƒظٹظ„ ط§ظ„ط­ط±ظˆظپ ظˆظˆطµظ„ظ‡ط§طŒ ظˆط§طھط¬ط§ظ‡ ظ…ظ† ط§ظ„ظٹظ…ظٹظ† ط¥ظ„ظ‰ ط§ظ„ظٹط³ط§ط± ظ…ط¹ ط¹ط²ظ„ ظƒظ„ ط³ط·ط± ط¹ط±ط¨ظٹطŒ ظˆظ…ط­ط§ط°ط§ط© طµط­ظٹط­ط© ظ„ط¹ظ„ط§ظ…ط§طھ ط§ظ„طھط±ظ‚ظٹظ…طŒ ظ…ط¹ ط®ط·ظˆط· ط¹ط±ط¨ظٹط© ظ…ط±ظپظ‚ط© (ط£ظ…ظٹط±ظٹطŒ طھط¬ظˆظ‘ظ„طŒ ط§ظ„ظ…ط±ط§ط¹ظٹ).
- **ط¬ظˆط¯ط© ط±ط³ظˆظ… ط¹ط§ظ„ظٹط©**: ط¹ط±ط¶ ظ…طھط¬ظ‡ظٹ ط¨ظ…ط­ط±ظ‘ظƒ Skia ظ…ط¹ طھظ†ط¹ظٹظ… ط§ظ„ط­ظˆط§ظپطŒ ظˆطھط¯ط±ط¬ط§طھ ظ„ظˆظ†ظٹط©طŒ ظˆط·ط¨ظ‚ط§طھطŒ ظˆط£ظ†ظ…ط§ط· ظ…ط²ط¬طŒ ظˆط¸ظ„ط§ظ„ ظˆطھظˆظ‡ط¬طŒ ظˆظپظڈط±ط´ ط±ط³ظ…طŒ ظˆطھطµط¯ظٹط± PNG ظˆJPEG ظˆWebP.
- **طھطµظ…ظٹظ… ط¨ط£ظ…ط± ظˆط§ط­ط¯**: ظٹظپظ‡ظ… ط§ظ„ط£ط¯ط§ط© `artforge_create_design` ط§ظ„ط·ظ„ط¨ ظˆظٹظƒطھط´ظپ ظ†ظˆط¹ ط§ظ„طھطµظ…ظٹظ… (ط¨ط·ط§ظ‚ط©طŒ ظ…ظ„طµظ‚طŒ ط¬ط¯ظˆظ„طŒ طµظپط­ط© ظ…ط³ط·ظ‘ط±ط©طŒ ظ…ط´ظ‡ط¯طŒ ط´ط®طµظٹط©â€¦)طŒ ط«ظ… ظٹط®ط·ط· ظˆظٹط±ط³ظ… ظˆظٹظڈطµط¯ظ‘ط± ظˆظٹظپط­طµ ط§ظ„ظ†طھظٹط¬ط© ط¨ظƒط³ظ„ظٹظ‹ط§ ظˆظٹط¹ظٹط¯ ظ…ط¹ط§ظٹظ†ط©.
- **طھط¹ط¯ظٹظ„ط§طھ ط¯ظ‚ظٹظ‚ط©**: ط¹ظ…ظ„ظٹط§طھ ط±ط³ظ… ط£ط³ط§ط³ظٹط© (`draw.rect`طŒ `draw.text`طŒ `draw.path`طŒ `draw.gradient`طŒ `draw.brush`â€¦) ظپط±ط¯ظٹظ‹ط§ ط£ظˆ ط¯ظپط¹ط© ظˆط§ط­ط¯ط©.
- **ط¢ظ…ظ† ظ„ظ„ط§ط³طھط¶ط§ظپط©**: ط®ط§ط¯ظ… ط§ظ„ط±ط³ظ… ظٹظ…ظ†ط¹ ط§ظ„ظˆطµظˆظ„ ظ„ظ…ظ„ظپط§طھ ط§ظ„ظ…ط¶ظٹظپ ظˆط§ط®طھظٹط§ط± ظ…ط²ظˆظ‘ط¯ط§طھ ط¹ط´ظˆط§ط¦ظٹط©ط› ظˆط§ظ„ظ…ظˆظ„ظ‘ط¯ ط§ظ„ظ…ط¯ظ…ط¬ ظ…طھط§ط­ ط¹ط¨ط± ط§ظ„ط¨ظˆط§ط¨ط© ط§ظ„ط¹ط§ظ…ط©طŒ ظˆطھط­ط¯ظ‘ ط§ظ„ط£ط¨ط¹ط§ط¯ ط¨ظ€ 1600 ط¨ظƒط³ظ„ ظ„ظƒظ„ ط¶ظ„ط¹طŒ ظˆطھط¹ط§ظ„ط¬ ط·ظ„ط¨ظ‹ط§ ظˆط§ط­ط¯ظ‹ط§ ظپظٹ ظƒظ„ ظ…ط±ط©.

### ط±ط¨ط· ط§ظ„ظ…ظƒظˆظ‘ظ† ط¨ط£ظٹ ظˆظƒظٹظ„

طµظپط­ط© ط§ظ„ظ…ط·ظˆظ‘ط± ظˆط±ط§ط¨ط· ط§ظ„ط®ط§ط¯ظ… ط§ظ„ظ…ط³طھط¶ط§ظپ ظ„ط±ط¨ط· ط§ظ„ظ…ظƒظˆظ‘ظ† ظ…ط¨ط§ط´ط±ط© ط¨ط£ظٹ ظˆظƒظٹظ„ ظٹط¯ط¹ظ… MCP:
**<https://obr.obr432.workers.dev/ai-plugins/#connect>**

ط£ظˆ ط´ط؛ظ‘ظ„ ط§ظ„ط®ط§ط¯ظ… ظ…ط­ظ„ظٹظ‹ط§ ظƒظ…ط§ ظٹظ„ظٹطŒ ط«ظ… ط£ط¶ظپ ط§ظ„ط¹ظ†ظˆط§ظ† `http://127.0.0.1:4273/mcp` ط¥ظ„ظ‰ ط¹ظ…ظٹظ„ MCP (ظ†ظ‚ظ„ HTTP).

### ط§ظ„طھط«ط¨ظٹطھ ظˆط§ظ„طھط´ط؛ظٹظ„

ط§ظ„ظ…طھط·ظ„ط¨ط§طھ: Node.js 20 ط£ظˆ ط£ط­ط¯ط« (ط§ط®طھظڈط¨ط± ط¹ظ„ظ‰ Node.js 24).

```sh
git clone https://github.com/duhbobaldo-oss/artforge-mcp-trial.git
cd artforge-mcp-trial
npm run setup      # ظٹط«ط¨ظ‘طھ ط§ط¹طھظ…ط§ط¯ظٹط© ظ…ط­ط±ظ‘ظƒ ط§ظ„ط±ط³ظ… (@napi-rs/canvas)
npm start          # ظٹط¨ط¯ط£ ط§ظ„ط®ط§ط¯ظ… ط¹ظ„ظ‰ http://127.0.0.1:4273/mcp
npm test           # ط§ط®طھط¨ط§ط± طھط´ط؛ظٹظ„ ط´ط§ظ…ظ„: طھظ‡ظٹط¦ط© MCPطŒ طھطµظ…ظٹظ… ط¹ط±ط¨ظٹطŒ طھطµط¯ظٹط± PNGطŒ ظˆظ‚ظٹظˆط¯ ط§ظ„ظ†ط³ط®ط©
```

- `GET /health` ظٹط¹ظٹط¯ `{"ok":true}`.
- `POST /mcp` ظٹط³طھظ‚ط¨ظ„ ط±ط³ط§ظ„ط© JSON-RPC ظˆط§ط­ط¯ط© ط¨طھط±ظˆظٹط³ط© `Content-Type: application/json` ظˆط¨طھط±ظ…ظٹط² UTF-8 (ظپظٹ ط³ط·ط± ط£ظˆط§ظ…ط± Windows ط§ط­ظپط¸ ط§ظ„ط·ظ„ط¨ ظپظٹ ظ…ظ„ظپ UTF-8 ظˆط£ط±ط³ظ„ظ‡ ط¨ظ€ `curl --data-binary @request.json` ط­طھظ‰ ظ„ط§ ظٹطھط­ظˆظ‘ظ„ ط§ظ„ظ†طµ ط§ظ„ط¹ط±ط¨ظٹ ط¥ظ„ظ‰ ظ…ط±ط¨ط¹ط§طھ ظپط§ط±ط؛ط©).
- ظ…ط­ظ„ظٹظ‹ط§ (`127.0.0.1`) ظ„ط§ ظٹظڈط·ظ„ط¨ ط±ظ…ط². ظ„ظ„ط±ط¨ط· ط¹ظ„ظ‰ ظˆط§ط¬ظ‡ط© ط´ط¨ظƒط© ط¹ط§ظ…ط© ظٹط¬ط¨ طھظ‚ط¯ظٹظ… ظ…ظ„ظپ ط±ظ…ط² ط¹ط¨ط± `ARTFORGE_DEMO_TOKEN_FILE` (ظ…ظ† 32 ط¥ظ„ظ‰ 128 ط­ط±ظپظ‹ط§ ظ…ظ† `A-Z a-z 0-9 _ -`)طŒ ظˆظٹط±ط³ظ„ ط§ظ„ط¹ظ…ظٹظ„ `Authorization: Bearer <token>`.
- ط§ظ„ظ†ط´ط± ط¹ط¨ط± Docker ظˆRender ظ…ظˆط¶ظ‘ط­ ظپظٹ [docs/trial-deployment.md](docs/trial-deployment.md).

### ط§ظ„ط£ط¯ظˆط§طھ ط§ظ„ظ…طھط§ط­ط©

| ط§ظ„ط£ط¯ط§ط© | ط§ظ„ظˆط¸ظٹظپط© |
|---|---|
| `artforge_create_design` | ظٹظ†ط´ط¦ طھطµظ…ظٹظ…ظ‹ط§ ظƒط§ظ…ظ„ظ‹ط§ ظ…ظ† ظˆطµظپ ظ†طµظٹ ظˆظٹط¹ظٹط¯ ط§ظ„ظ…ط¹ط§ظٹظ†ط© ظˆظ†طھط§ط¦ط¬ ط§ظ„ظپط­طµ |
| `artforge_plan_design` / `artforge_execute_design` | طھط®ط·ظٹط· ط§ظ„طھطµظ…ظٹظ… ط«ظ… طھظ†ظپظٹط°ظ‡ ط¹ظ„ظ‰ ظ…ط±ط­ظ„طھظٹظ† |
| `artforge_tool_op` | ط¹ظ…ظ„ظٹط§طھ `draw.*` ط§ظ„ط£ط³ط§ط³ظٹط©طŒ ط£ظˆ `batch` ظ„ط¹ط¯ط© ط¹ظ…ظ„ظٹط§طھطŒ ظˆظ‚ط±ط§ط،ط© ط§ظ„ظ…ط³طھظ†ط¯ ظˆظ…ط¹ط§ظٹظ†طھظ‡ |
| `artforge_export` | طھطµط¯ظٹط± PNG ط£ظˆ JPEG ط£ظˆ WebP |
| `artforge_tool_docs` | ط¥ط¬ط±ط§ط، ط§ظ„طھط´ط؛ظٹظ„طŒ ظˆط¯ظ„ظٹظ„ ط§ظ„ظ…ظ‡ط§ط±ط§طھطŒ ظˆطھظˆط¬ظٹظ‡ ط§ظ„ط·ظ„ط¨ ظ„ظ„ظ…ظ‡ط§ط±ط© ط§ظ„ظ…ظ†ط§ط³ط¨ط© |
| `artforge_capabilities` / `artforge_status` / `artforge_artifacts` | ط§ظ„ظ‚ط¯ط±ط§طھ ظˆط§ظ„ط­ط§ظ„ط© ظˆط§ظ„ظ…ظ„ظپط§طھ ط§ظ„ظ†ط§طھط¬ط© |
| `artforge_get_reference` / `artforge_book_knowledge` | ظ„ظˆط­ط© ط§ظ„ط£ظ„ظˆط§ظ† ظˆظ†ط¸ط§ظ… ط§ظ„طھطµظ…ظٹظ… ط§ظ„ظ…ط±ظپظ‚ط§ظ†طŒ ظˆط§ظ„ظ…ط¹ط±ظپط© ط§ظ„ظ…ط±ط¬ط¹ظٹط© |

### ط¨ظ†ظٹط© ط§ظ„ظ…ط³طھظˆط¯ط¹

| ط§ظ„ظ…ط³ط§ط± | ط§ظ„ظ…ط­طھظˆظ‰ |
|---|---|
| `server.js` | ط®ط§ط¯ظ… HTTP ظ„ط¨ط±ظˆطھظˆظƒظˆظ„ MCPطŒ ظ…ط¹ ظ‚ظٹظˆط¯ ط§ظ„ط£ظ…ط§ظ† ظˆط§ظ„ط£ط¨ط¹ط§ط¯ |
| `artforge-mcp/` | ظˆط­ط¯ط© MCP: ط§ظ„طھط®ط·ظٹط·طŒ ظˆظ…ظˆط¬ظ‘ظ‡ ط§ظ„ظ…ظ‡ط§ط±ط§طھطŒ ظˆط§ظ„ظ…ظ‡ط§ط±ط§طھ (`skills/`)طŒ ظˆط§ظ„ط¬ط³ط± ط¥ظ„ظ‰ ظ…ط­ط±ظ‘ظƒ ط§ظ„ط±ط³ظ… |
| `drawing-tool/` | ظ…ط­ط±ظ‘ظƒ ط§ظ„ط±ط³ظ… ظˆط§ظ„ط®ط·ظˆط· ط§ظ„ط¹ط±ط¨ظٹط© ط§ظ„ظ…ط±ظپظ‚ط© ظˆطھط±ط§ط®ظٹطµظ‡ط§ |
| `docs/` | طھظˆط«ظٹظ‚ ط§ظ„ط¹ظ…ظ„ظٹط§طھ ظˆط§ظ„ط®ط·ظˆط· ظˆط§ظ„طھطµط¯ظٹط± ظˆط§ظ„ط­ط¯ظˆط¯ ([docs/README.md](docs/README.md)) |
| `test/` | ط§ط®طھط¨ط§ط± ط§ظ„طھط´ط؛ظٹظ„ ط§ظ„ط´ط§ظ…ظ„ |

### ط§ظ„ظ…ط³ط§ظ‡ظ…ط© ظˆط§ظ„طھط±ط®ظٹطµ

ظ†ط±ط­ظ‘ط¨ ط¨ط§ظ„ظ…ط³ط§ظ‡ظ…ط§طھط› ط§ظ‚ط±ط£ [CONTRIBUTING.md](CONTRIBUTING.md). ط§ظ„ظ…ط´ط±ظˆط¹ ظ…ط±ط®ظ‘طµ ط¨ظ…ظˆط¬ط¨ [Apache License 2.0](LICENSE)طŒ ظˆط§ظ„ط®ط·ظˆط· ط§ظ„ظ…ط±ظپظ‚ط© ط¨ظ…ظˆط¬ط¨ SIL Open Font License 1.1. ط§ظ„طھظپط§طµظٹظ„ ظپظٹ [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

</div>

---

## English

**ArtForge AI MCP** is an open-source, Arabic-first 2D drawing and design engine that AI agents use through the Model Context Protocol (MCP). It is an **OBR Group** project.

### Highlights

- **Native Arabic support**: correct letter shaping and joining, right-to-left layout with per-line bidi isolation, proper punctuation placement, and bundled Arabic fonts (Amiri, Tajawal, Almarai).
- **High-quality graphics**: anti-aliased vector rendering on Skia, gradients, layers, blend modes, shadows and glows, brush strokes, and PNG / JPEG / WebP export.
- **One-call design**: `artforge_create_design` reads the request, detects the design type (card, poster, table, ruled page, scene, character, â€¦), plans, draws, exports, runs pixel QA and returns a preview.
- **Precise edits**: primitive operations (`draw.rect`, `draw.text`, `draw.path`, `draw.gradient`, `draw.brush`, â€¦) one at a time or as a batch.
- **Safe to host**: the renderer blocks host-file access and arbitrary providers; the integrated image generator is exposed by the public gateway, caps canvases at 1600 px per side, and serves one request at a time.

### Connect it to any agent

Developer page and hosted server URL for connecting ArtForge directly to any MCP-capable agent:
**<https://obr.obr432.workers.dev/ai-plugins/#connect>**

Or run the server locally (below) and add `http://127.0.0.1:4273/mcp` to your MCP client as an HTTP server.

### Install and run

Requirements: Node.js 20 or later (tested on Node.js 24).

```sh
git clone https://github.com/duhbobaldo-oss/artforge-mcp-trial.git
cd artforge-mcp-trial
npm run setup      # installs the drawing-engine dependency (@napi-rs/canvas)
npm start          # serves MCP at http://127.0.0.1:4273/mcp
npm test           # end-to-end smoke test: MCP handshake, Arabic design, PNG export, trial limits
```

- `GET /health` returns `{"ok":true}`.
- `POST /mcp` accepts one JSON-RPC message with `Content-Type: application/json`.
- On `127.0.0.1` no token is required. Binding to a public interface requires a token file via `ARTFORGE_DEMO_TOKEN_FILE` (32â€“128 characters of `A-Z a-z 0-9 _ -`); clients send `Authorization: Bearer <token>`.
- Environment variables: `HOST` (default `127.0.0.1`), `PORT` (default `4273`), `ARTFORGE_DEMO_TOKEN_FILE`.
- Docker and Render deployment: [docs/trial-deployment.md](docs/trial-deployment.md).

Example request:

```sh
curl -s http://127.0.0.1:4273/mcp -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"artforge_create_design","arguments":{"prompt":"ط¨ط·ط§ظ‚ط© طھط±ط­ظٹط¨","headline":"ظ…ط±ط­ط¨ظ‹ط§ ط¨ط§ظ„ط¹ط±ط¨ظٹط©","width":900,"height":480}}}'
```

> Requests must be UTF-8. On Windows shells, non-ASCII command-line arguments can be re-encoded and Arabic then renders as empty boxes; save the JSON to a UTF-8 file and send it with `curl --data-binary @request.json` instead.

### Tools

| Tool | Purpose |
|---|---|
| `artforge_create_design` | Build a complete design from a prompt; returns preview and QA results |
| `artforge_plan_design` / `artforge_execute_design` | Two-step plan, then execute |
| `artforge_tool_op` | Primitive `draw.*` operations, `batch`, document info and preview |
| `artforge_export` | Export PNG, JPEG or WebP |
| `artforge_tool_docs` | Operating procedure, skill guides and request routing |
| `artforge_capabilities` / `artforge_status` / `artforge_artifacts` | Capabilities, status and generated files |
| `artforge_get_reference` / `artforge_book_knowledge` | Bundled palette and design system, reference knowledge |

### Repository layout

| Path | Contents |
|---|---|
| `server.js` | HTTP MCP server with security and size limits |
| `artforge-mcp/` | MCP module: planner, skill router, skills (`skills/`), drawing-engine bridge |
| `drawing-tool/` | Drawing engine, bundled Arabic fonts and their licenses |
| `docs/` | Operations, fonts, export and limits documentation ([docs/README.md](docs/README.md)) |
| `test/` | End-to-end smoke test |

### Contributing and license

Contributions are welcome â€” see [CONTRIBUTING.md](CONTRIBUTING.md). Licensed under the [Apache License 2.0](LICENSE). Bundled fonts are under the SIL Open Font License 1.1; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

آ© OBR Group
