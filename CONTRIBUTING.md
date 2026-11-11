# Contributing to ArtForge AI MCP

<div dir="rtl" align="right">

شكرًا لاهتمامك بالمساهمة! نرحّب بتقارير الأخطاء، واقتراحات التحسين، وتحسين التوثيق العربي والإنجليزي، وطلبات الدمج. الإرشادات التفصيلية بالإنجليزية أدناه، ويمكنك الكتابة في القضايا وطلبات الدمج بالعربية أو بالإنجليزية.

</div>

Thank you for helping improve ArtForge. Issues and pull requests may be written in Arabic or English.

## Getting started

1. Fork the repository and create a branch from `main` (`feat/…`, `fix/…`, `docs/…`).
2. Install and verify (Node.js 20 or later):

   ```sh
   npm run setup
   npm test
   ```

3. Run the server locally with `npm start` and point your MCP client at `http://127.0.0.1:4273/mcp`.

## Making changes

- **Keep changes focused.** One problem per pull request. Fix root causes rather than adding special cases.
- **Do not change rendering behaviour silently.** If a change alters how existing designs render, say so in the
  pull request and attach before/after previews.
- **Arabic first.** Changes that touch text must keep Arabic shaping, RTL order and punctuation correct. Include
  an Arabic example in tests or in the pull request description.
- **Security limits stay on.** Do not weaken the checks in `server.js` (host-file parameters, export formats,
  canvas size, request size, origin and token checks) without discussing it in an issue first.
- **No new dependencies without a concrete need.** The engine currently depends only on `@napi-rs/canvas`.
- **Style.** CommonJS, `'use strict'`, two-space indentation, and Node.js built-ins where possible. Match the
  style of the file you are editing.
- **Tests.** Add or update tests under `test/` (Node.js built-in test runner, `node:test`) and make sure
  `npm test` passes.
- **Docs.** Update `README.md` (both languages) and `docs/` when behaviour or usage changes.

## Assets and licensing

- By contributing you agree that your contribution is licensed under the [Apache License 2.0](LICENSE).
- Only add fonts, images or data you have the right to distribute, together with their license text. Fonts go in
  `drawing-tool/fonts/` with their license in `drawing-tool/fonts/licenses/`, and must be listed in
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- Never commit secrets, tokens, `.env` files, personal data or generated outputs (`outputs/`, `logs/`,
  `drawing-tool/data/`, `artforge-mcp/data/` other than `references.index.json`).

## Reporting bugs

Open an issue with: what you sent (tool name and arguments), what you expected, what happened, the preview image
if relevant, your Node.js version and operating system.

## Security issues

Please do not open public issues for security vulnerabilities. Contact the maintainers privately through the
OBR Group developer page (https://obr.obr432.workers.dev/ai-plugins/) and allow time for a fix before disclosure.
