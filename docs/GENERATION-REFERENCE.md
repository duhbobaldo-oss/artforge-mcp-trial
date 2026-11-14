# Draw, then generate from the drawing

The public MCP gateway and optional owner Cloudflare adapter both support real
drawing references. Public workflow: first call `artforge_create_design`, then:

```json
{"action":"submit","operationId":"cabin-3d-unique","documentId":"doc_example","prompt":"Transform image 0 into a stylized 3D cartoon. Keep the composition and objects.","width":512,"height":512}
```

Send that to `artforge_generate_image`, then poll `action:get` with the returned
jobId. The public path permits output dimensions 256–512 in multiples of 16,
three reservations per connection per UTC day, a shared estimated 900-Neuron
daily cap, and 24-hour result retention. A reference reserves a conservative
52.10 Neurons rather than the 26.05 estimate for text-only output. No schema or
data migration is needed: source metadata uses the existing job JSON.

The gateway checks document ownership before any renderer access or quota
reservation. It retrieves `document.info` and `document.preview` through the
existing authenticated origin MCP. For inline previews exceeding the text limit,
it uses the existing `artforge_export` bounded image block. It validates PNG header,
dimensions and SHA256 before passing the actual binary image to Workers AI.
No new Render endpoint or credentials are required. Read/export requests have
bounded deadlines; generation has no automatic inference retries.
Authenticated renderer requests use Workers-compatible `redirect: "manual"` and
reject non-success statuses, including all redirects, without forwarding the
origin credential. Errors report only a bounded phase/status, never response
bodies, paths or credentials.

The optional installed owner adapter uses the existing `artforge_tool_op`:

```json
{"op":"generation.generate","params":{"operationId":"cabin-3d-unique","documentId":"doc_example","prompt":"Transform image 0 into a stylized 3D cartoon. Keep the furniture placement, open book, fireplace and composition.","width":1024,"height":1024}}
```

Call `generation.status` first. `referenceInput: "documentId"` indicates support.
The ordinary ArtForge drawing path and text-only generation remain available.
Generation returns a raster image with a 3D appearance, not an editable 3D mesh.

The server reads and renders the existing document with its authoritative Skia
renderer, validates the PNG, and bounds both dimensions to less than 512px.
The owner adapter sends those actual PNG bytes in Cloudflare's documented
multipart `input_image_0` field. The model is `@cf/black-forest-labs/flux-2-klein-4b`.

The result's `source` includes `mode: "image-to-image"`, `referenceDocumentId`,
`referenceSha256`, `referenceWidth` and `referenceHeight`. These identify the exact
reference bytes submitted; they do not guarantee visual fidelity or identical text.
The output hash is separate from the bounded preview hash. The original drawing
is never modified. The existing owner adapter still returns a bounded preview;
it does not automatically create a saved generated document.

Only an existing authorized document ID is accepted. No input URL, arbitrary
filesystem path, raw upload, credential or provider selection is accepted.
Public gateway ownership checks already recognize the nested `documentId` key;
the new API deliberately reuses that key rather than introducing an unchecked ID.
The public endpoint enforces ownership itself even when called through cached
`generation.jobs.*` or `generation.generate` aliases. A missing or cross-connection
drawing fails before inference. Cached `generation.status` returns the public
generator capabilities rather than the origin's disabled owner configuration.

Invalid or unavailable references fail before inference, rather than silently
falling back to text-only generation. The reference hash participates in operation
idempotency: reusing an operation ID after changing the drawing conflicts.
No inference retries or paid fallback are added. Existing persistent daily budget
reservations still apply. Owner receipts remain process-local and bounded to 32;
public jobs keep their existing durable idempotency, retrieval, cancellation,
delete/purge and expiry policy. Source PNG bytes are used transiently, not stored
in D1; only the reference ID, dimensions and hash are retained with the job.

Official provider contract:
https://developers.cloudflare.com/changelog/post/2026-01-15-flux-2-klein-4b-workers-ai/

## Validation

Unit and integration tests cover malformed input, portrait/landscape bounds,
exact multipart bytes, missing documents, unsupported adapters, no duplicate
inference, changed-reference conflicts, real renderer and saved-document restart.
Existing tests cover rejected provider/auth responses, malformed output, timeouts,
cancellation, budgets, failed receipt retention and text-only compatibility.

Live-provider and connected-MCP results must be reported separately from tests.
