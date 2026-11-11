# Owner-managed Cloudflare generation

The public gateway uses its AI binding and its own D1 quotas. The installed owner MCP can opt into the same fixed model through its existing `generation.generate` adapter, independently of the public gateway. All other installations remain disabled by default.

Node.js 24 is required. Authenticate Wrangler on the owner machine using the documented Cloudflare OAuth flow. Do not copy OAuth tokens into source, this file, or MCP requests.

Create the ignored `artforge-mcp/data/owner-generation.json` with `enabled: true`, `provider: "cloudflare-flux2-klein-4b"`, `freePlanConfirmed: true`, the owner's 32-character `accountId`, and an absolute `wranglerCli` path to its existing CLI. This is trusted operator configuration, not an MCP tool. Omit the file or set enabled false to disable. Restart the MCP child using the existing supervisor; preserve its renderer and tunnel configuration.

Call `artforge_tool_op` with `op: "generation.status"`, then `op: "generation.generate"` and params `operationId`, `prompt`, `width`, `height`. Use a stable operationId. Dimensions: 256–1024, multiples of 16. Exact text should be added with the existing editable text tools after generation, rather than requested from the image model.

Local adapter receipts are process-local; the SQLite usage ledger survives restarts and refuses a previously reserved operation rather than repeating inference. A repeated request after restart can therefore return a provider error and does not recover an old image. The public asynchronous jobs provide durable retrieval and per-connection ownership. The local adapter returns a bounded PNG preview and does not create a saved document automatically.

The local SQLite budget permits at most 900 estimated Neurons/day. This is separate from the public gateway's shared 900-Neuron budget. Cloudflare's account-level free allowance is also shared with any unrelated applications. No paid fallback or automatic inference retry is implemented.
