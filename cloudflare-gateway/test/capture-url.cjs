// Stand-in "browser" for headless OAuth tests: records the URL Claude Code wants to open.
require('fs').writeFileSync(require('path').join(__dirname, '..', '..', 'tmp-captured-url.txt'), process.argv.slice(2).join(' '));
