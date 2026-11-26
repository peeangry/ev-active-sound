// Builds the bookmarklet (core.js + bookmarklet.js, minified) and the web page that hands it out.
//   node web/build.js   ->  web/dist/bookmarklet.min.js, web/dist/index.html
'use strict';
const fs = require('fs');
const path = require('path');
const { minify } = require('terser');

(async () => {
  const root = path.join(__dirname, '..');
  const src = `(function(){var module;\n${fs.readFileSync(path.join(root, 'core.js'), 'utf8')}\n${fs.readFileSync(path.join(__dirname, 'bookmarklet.js'), 'utf8')}\n})();`;
  const { code } = await minify(src, { ecma: 2020, compress: { passes: 2 }, mangle: true, format: { ascii_only: true } });
  const dist = path.join(__dirname, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, 'bookmarklet.min.js'), code);
  const page = fs.readFileSync(path.join(__dirname, 'page.html'), 'utf8')
    .replace('"__BOOKMARKLET_CODE__"', () => JSON.stringify(code).replace(/</g, '\\u003c'));
  fs.writeFileSync(path.join(dist, 'index.html'), page);
  console.log(`bookmarklet: ${code.length} chars (${encodeURIComponent(code).length} as a URL)`);
})();
