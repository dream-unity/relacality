#!/usr/bin/env node
/**
 * Deterministic, dependency-free packaging of this application's fixed module
 * graph. Each module keeps its lexical scope inside an IIFE. Imports become
 * namespace destructuring; no application logic is rewritten or minified.
 *
 * Run from any directory with Node 22+: node scripts/build-standalone.mjs
 */
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'offline', 'relacality.html');
const graph = [
  { file: 'ontology.js', namespace: '__ontology', exports: ['CATEGORIES', 'FORMS', 'KEYS', 'KEY_BY_ID', 'KEY_BY_CODE'] },
  { file: 'audio-engine.js', namespace: '__audio', exports: ['CLOCK_VOICES', 'beatDuration', 'nextBeatTime', 'normalizeClock', 'createDefaultClocks', 'AudioEngine'] },
  { file: 'game-engine.js', namespace: '__game', exports: ['generateChallenge', 'evaluatePerformance', 'compareWorlds', 'generateComparison'] },
  { file: 'app.js', namespace: '__app', exports: [] },
];
const completed = new Map();
const bundled = [];
for (const module of graph) {
  let source = await readFile(path.join(root, module.file), 'utf8');
  source = source.replace(/^import\s*\{([^}]+)\}\s*from\s*['"]\.\/([^'"]+)['"];?\s*$/gm, (_, bindings, dependency) => {
    const resolved = completed.get(dependency);
    if (!resolved) throw new Error(`${module.file}: unexpected or out-of-order dependency ${dependency}`);
    const names = bindings.split(',').map(name => name.trim()).filter(Boolean);
    for (const name of names) {
      if (!/^[A-Za-z_$][\w$]*$/.test(name) || !resolved.exports.includes(name)) {
        throw new Error(`${module.file}: unsupported or missing named import ${name}`);
      }
    }
    return `const { ${names.join(', ')} } = ${resolved.namespace};\n`;
  });
  const foundExports = [];
  source = source.replace(/^export\s+(const|function|class)\s+([A-Za-z_$][\w$]*)/gm, (_, declaration, name) => {
    foundExports.push(name);
    return `${declaration} ${name}`;
  });
  if (JSON.stringify([...foundExports].sort()) !== JSON.stringify([...module.exports].sort())) {
    throw new Error(`${module.file}: exports changed; update the fixed graph before packaging`);
  }
  // Any unsupported module syntax now causes a syntax error instead of silently
  // producing an incomplete standalone application.
  const code = `const ${module.namespace} = (() => {\n'use strict';\n${source}\nreturn Object.freeze({ ${module.exports.join(', ')} });\n})();`;
  new vm.Script(code, { filename: module.file });
  bundled.push(`/* ${module.file} */\n${code}`);
  completed.set(module.file, module);
}

const javascript = `(() => {\n'use strict';\n${bundled.join('\n\n')}\n})();`;
new vm.Script(javascript, { filename: 'relacality-standalone.js' });
const [template, styles, favicon] = await Promise.all([
  readFile(path.join(root, 'index.html'), 'utf8'),
  readFile(path.join(root, 'styles.css'), 'utf8'),
  readFile(path.join(root, 'favicon.svg'), 'utf8'),
]);
if (/@import\b|url\(\s*['"]?(?!data:|#)/i.test(styles)) {
  throw new Error('styles.css now contains an external asset; embed it before packaging');
}
function replaceOnce(html, expected, replacement) {
  if (html.split(expected).length !== 2) throw new Error(`Expected exactly one template marker: ${expected}`);
  return html.replace(expected, () => replacement);
}
let html = replaceOnce(template, '<link rel="stylesheet" href="./styles.css">', `<style>\n${styles.replace(/<\/style/gi, '<\\/style')}\n</style>`);
html = replaceOnce(html, '<link rel="icon" type="image/svg+xml" href="./favicon.svg">', `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(favicon)}">`);
html = replaceOnce(html, '<script type="module" src="./app.js"></script>', `<script>\n${javascript.replace(/<\/script/gi, '<\\/script')}\n</script>`);
// A standalone file may be renamed or moved. Keep its home link in this page.
html = replaceOnce(html, '<a class="brand" href="./"', '<a class="brand" href="#"');
if (/<(?:script|link|img|audio|video)\b[^>]*\b(?:src|href)\s*=\s*['"](?:\.\/|https?:)/i.test(html)) {
  throw new Error('The packaged document still has an external runtime asset');
}
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, html, 'utf8');
process.stdout.write(`Built offline/relacality.html (${Buffer.byteLength(html)} bytes); JavaScript syntax verified.\n`);
