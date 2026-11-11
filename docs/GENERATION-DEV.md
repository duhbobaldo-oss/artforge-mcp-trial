# Internal generation foundation — DEV only

This is the first implementation of the 2026-11-11 architecture proposal. It is **not a validated neural image generator or a cloud deployment**. No model or library was downloaded, and no paid provider was called. Existing renderer and SceneSpec v1 remain authoritative.

## Actual entry points

`createMcpEngine({ generationJobs: { enabled:true, ownerId, provider } })` wires the persistent coordinator to the existing ToolBridge, image asset store, Skia renderer, editable Arabic text, project persistence, PNG exporter and ArtifactStore. Ordinary engine construction keeps it disabled and does not open SQLite. Legacy `generation.status/generate` are unchanged.

Optional new operations use `artforge_tool_op`:

- `generation.jobs.status`: feature status.
- `generation.jobs.submit`: strict GenerationSpec v1 below; returns a job immediately.
- `generation.jobs.get`: `{jobId}`; read persisted state/result.
- `generation.jobs.cancel`: `{jobId}`; persist cancellation and stop the provider.
- `generation.jobs.delete`: `{jobId}`; remove stored prompt, original PNG and result logically, retain a minimal idempotency tombstone. Saved project/assets/exports are intentionally preserved and remain manageable through the existing document/image/artifact lifecycle. Active jobs cannot be removed.
- `generation.jobs.preview`: `{jobId}`; bounded preview of the saved final composite, including editable text. Result includes full PNG artifact URI; existing artifact resource readers provide the complete PNG.

```json
{
  "version": 1,
  "operationId": "example_1",
  "prompt": "A quiet moonlit room, no lettering",
  "width": 1024,
  "height": 1024,
  "seed": 7,
  "overlays": [
    {"text":"غرفة هادئة","x":80,"y":80,"w":864,"h":100,"fontSize":48,"rtl":true,"color":"#ffffff"}
  ]
}
```

Coordinates in this contract describe the **left edge of a box**, including RTL. The adapter converts RTL x to the renderer's right anchor. Width/height are multiples of 16, 64–2048; seed is uint32; at most 20 overlays, each at most 2000 characters. Unknown fields are rejected: no silent acceptance of unsupported reference images, masks, pose controls or model selection. The first worker implements text-to-image only. Reference-conditioned generation and compilation from the existing planner remain subsequent work.

## Isolation and persistence

Owner identity is trusted application configuration, never a tool parameter. All job queries constrain owner. Current launcher is **single-owner stdio DEV**; do not expose it through public HTTP or enable it in the cloud gateway. Complete multi-tenant document/asset isolation must be verified before public deployment, beyond isolated job rows.

SQLite uses WAL/FULL synchronization, schema version 1, a unique `(owner,operationId)` receipt and atomic submission/quota checks. One coordinator owns one database, and one worker runs at a time. Defaults: 4 pending globally, 32 nonremoved jobs per owner, 1024 retained receipts per owner. Removal releases live-job quota, not receipt identity. No silent eviction or automatic retry. These are DEV limits, not production capacity guarantees.

Queued work resumes after restart. Interrupted running work becomes `GENERATION_INTERRUPTED` and is never automatically regenerated. A job that crashed during document creation may have a partial saved document; inspect it by job name before any retry. Worker cancellation waits for process exit before admitting another job. Provider implementations injected by the owner must honor AbortSignal; the shipped subprocess provider terminates its Python process.

On a crash, startup fails closed if `coordinator.lock` remains. Owner-only `recoverGenerationLock(dir)` checks the recorded PID is dead, serializes recovery, removes only that lock, and preserves the database. It is not exposed as an MCP operation. Normal `close()` releases the lock. Future database versions are rejected without downgrading. Recovery strategy is application rollback by disabling this optional feature and retaining the isolated job database; clean/reopen/future-version tests are included. SQLite logical deletion is not a promise of forensic secure erasure.

## Real local worker

`generation-worker/worker.py` uses the documented `Flux2KleinPipeline`, BF16, 4 inference steps, guidance 1.0 and explicit seed. It loads owner-provisioned local safetensors with offline environment flags; no model download or external inference API. One Python process loads the model per job in this initial implementation. Warm-worker caching is **not implemented** and should follow real profiling.

From `artforge-mcp`, run:

```powershell
node tools/serve-generation-dev.js --probe
```

Missing dependencies/model/CUDA readiness returns exit 2 and structured `ready:false`; it does not install anything. In this environment torch/diffusers/transformers and model weights are absent. The known MX350 2GB is not a practical target for this model. No claim of GPU/model compatibility is made from the protocol fixture.

Only on a suitable owner-controlled GPU machine, after provisioning and verifying model weights and compatible pinned dependencies, set:

```powershell
$env:ARTFORGE_GENERATION_DEV='1'
$env:ARTFORGE_LOCAL_MODEL_DIR='<LOCAL_VERIFIED_MODEL_DIRECTORY>'
$env:ARTFORGE_LOCAL_MODEL_PROFILE_SHA256='<64_LOWERCASE_HEX_PROFILE_FINGERPRINT>'
$env:ARTFORGE_TOOL_URL='http://127.0.0.1:4391'
node tools/serve-generation-dev.js
```

The drawing tool must be an explicitly started isolated DEV renderer; the launcher rejects production port 4173 and does not start a renderer itself. `profileHash` currently binds idempotency and records an owner-supplied configuration fingerprint; it is **not automatic verification of all weight bytes**. A complete locked inference environment and weight-manifest verification are remaining GPU acceptance work. Do not enable FLUX 3 or accept its license through this launcher.

Source API used: [official FLUX.2 Klein 4B model card](https://huggingface.co/black-forest-labs/FLUX.2-klein-4B). The model card describes text and reference-image capabilities, but this first adapter deliberately exposes only the implemented text-to-image path.

## Verification and limitations

`node tools/test-generation-regression.js` runs the configured MCP suite against an owned temporary localhost renderer with a unique port. It never reuses 4173/4391. Reference folders and original user-supplied PDFs must be present for the existing knowledge tests.

`node tools/generation-foundation-evidence.js` retains an integration image/project/manifest and measures 100 deterministic 64px test jobs. This is a fixture scheduler/storage measurement, **not neural generation latency or image quality**. The rendered sample labels itself as a fixture.

Remaining gates: actual model loading and generation on suitable GPU; pinned packages/weight manifests; reference/Scene Graph compiler; multimodal retrieval evaluation; anatomy/style/reference acceptance; cancellation and VRAM recovery under CUDA; retention automation; complete public-service tenant isolation; actual ChatGPT visual delivery; cloud cold-start acceptance. Production is unchanged.
