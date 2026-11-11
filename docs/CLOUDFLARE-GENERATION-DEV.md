# Cloudflare Workers AI → ArtForge DEV

Implemented 2026-11-11. Production local and cloud code, gateway, tunnel, domains and billing are unchanged.

## Runtime path

`tools/serve-cloudflare-generation-dev.js` → existing MCP → persistent GenerationJobs → CloudflareImageProvider → fixed Cloudflare REST model endpoint → strict PNG/JPEG validation → existing image asset + Skia document + editable Arabic overlay → saved project + PNG + artifact + MCP preview.

Cloudflare model: `@cf/black-forest-labs/flux-2-klein-4b`. No Worker is deployed. The renderer listens on an owned ephemeral loopback port. It never connects to production 4173. Original `generation.generate` and ordinary engine construction remain unchanged/disabled. New operations use `generation.jobs.*` as documented in GENERATION-DEV.md.

## Owner configuration

The local stdio launcher requires these owner-set environment variables, never MCP parameters:

```powershell
$env:ARTFORGE_CLOUDFLARE_FREE_DEV='1'
$env:ARTFORGE_CLOUDFLARE_ACCOUNT_ID='<OWNER_ACCOUNT_ID>'
$env:ARTFORGE_WRANGLER_CLI='<EXISTING_WRANGLER_PACKAGE>/bin/wrangler.js'
node tools/serve-cloudflare-generation-dev.js
```

`artforge-generation-dev` was registered as a separate Codex stdio MCP entry pointing to this launcher. Its direct stdio status call and graceful shutdown passed. Tools may require a new Codex session to be discovered; the installed ArtForge production connector has not been replaced.

Authentication uses the official `wrangler auth token --json` handoff, captured only in process memory. No API token is created, no secret is stored in source/config/reports, no token is sent anywhere except `https://api.cloudflare.com`. Existing Wrangler credentials are reused and refreshed by Wrangler. Do not print the command's raw output.

## Cost and failure behavior

- The owner supplied a screenshot showing Workers Free as the current plan. Free inference was authorized; the adapter does not change that plan or add billing.
- Fixed model and 256–1024px bounds; no external URLs/models can be selected by MCP callers.
- SQLite daily reservations are global to this DEV account across launcher instances. Default ceiling is **900 estimated Neurons/day**, below the platform's documented 10,000 free allocation. This is an additional local ceiling, not knowledge of the account's remaining shared quota.
- Per-output estimate is `ceil(ceil(width/512)*ceil(height/512)*26.05)` from the documented rate. A 512px image reserves 27 locally. Price changes require review; this estimate is not an actual usage receipt from Cloudflare.
- Uncertain/failed requests retain reservations, preventing silent regeneration. No automatic inference retries. Budget checking and duplicate reservation are transactional and durable.
- Account exhaustion/rate limiting is reported; no fallback to paid APIs or a different model.
- Timeouts and cancellation abort local HTTP waiting. Cloudflare may already have started GPU work; remote cancellation/zero usage is **not guaranteed**.

## Validation

`node --test tests/cloudflare-image-provider.test.js tests/generation-jobs.test.js tests/generative-image-adapter.test.js` passed 30/30. It covers fixed multipart request fields, PNG/JPEG contracts, credential redaction, HTTP rejection, rate limiting, malformed images, dimensions, budget, duplicate reservation, timeout/cancellation and existing persistence/MCP behavior. Unit transport doubles do not prove provider availability.

`node tools/cloudflare-live-dev.js`, with the owner environment above, separately ran **one actual 512×512 image** through the real API and ArtForge MCP/HTTP renderer. It saved the project, reopened it, verified an editable text object and an MCP image block. The image was visually inspected. Job duration was about 7.588 seconds, including credential retrieval and rendering/storage; it is not isolated GPU latency.

The first Cloudflare MCP inference attempts returned 401 with the metadata-scoped connection, including after a CLI OAuth scope update. This was not treated as model success. The actual live test succeeded through the documented Wrangler credential handoff and direct REST adapter. No claim that Cloudflare MCP's inference transport itself now works.

Official references: [model input contract](https://developers.cloudflare.com/changelog/post/2026-01-15-flux-2-klein-4b-workers-ai/), [pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/), [credential handoff](https://developers.cloudflare.com/changelog/post/2025-12-18-wrangler-auth-token/).

## Boundaries

This connection is single-owner local DEV. It is not public-service tenant acceptance. No public listener or production deployment is configured. Reference-conditioned images, masks/pose/depth, Scene Graph compilation, broad anatomy/style benchmarking and LoRA remain separate phases. Unsupported fields are rejected. No global image quality claim follows from one attractive sample.
