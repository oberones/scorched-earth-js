// Bundle src/ into a single self-contained dist/index.html
// Usage: node tools/build.js
const fs = require('fs');
const path = require('path');
const SRC = path.join(__dirname, '..', 'src');
const OUT = path.join(__dirname, '..', 'dist');
let html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
html = html.replace(/<link rel="stylesheet" href="([^"]+)">/g, (_, f) => `<style>\n${fs.readFileSync(path.join(SRC, f), 'utf8')}</style>`);
const scripts = [];
html = html.replace(/<script src="([^"]+)"><\/script>\n?/g, (_, f) => { scripts.push(f); return ''; });
const js = scripts.map(f => `// ---- ${f}\n${fs.readFileSync(path.join(SRC, f), 'utf8')}`).join('\n');
const inline = `<script>\n"use strict";\n${js.replace(/<\/script/gi, '<\\/script')}\n</script>\n</body>`;
html = html.replace('</body>', () => inline); // function form: no $-pattern expansion
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'index.html'), html);
console.log(`dist/index.html  ${(html.length / 1024).toFixed(1)} KB  (${scripts.length} scripts inlined)`);
