// The models the native game loads, for -DSL_COPY_ASSETS=ON (packaging without the repository): every model the
// exported data names (native/data/*.json.zst: the resort's props, the transport's cars and buses, the courses' pieces,
// the job boards, the snowmobiles, the furniture catalogue...) and every model the C++ names (string literals in
// native/src that are, alone or joined to a literal prefix / suffix the code builds names with, a file under
// public/models: "heli_body", "prison/bunk_bed", "furniture/" + a catalogue id, "skier_" + a colour + "_rigged"...).
//   node native/tools/list_models.mjs <out.txt>     one model name per line (without .glb), sorted
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const native = path.resolve(here, '..'), root = path.resolve(native, '..');
const models = path.join(root, 'public', 'models');
const out = process.argv[2] || path.join(native, 'build', 'models.txt');

const exists = (n) => n && !n.includes('..') && fs.existsSync(path.join(models, `${n}.glb`));
const found = new Set();
const strings = new Set();

// the exported data: every string in the JSON files
for (const f of fs.readdirSync(path.join(native, 'data'))) {
  if (!/\.json(\.zst)?$/.test(f)) continue;
  let b = fs.readFileSync(path.join(native, 'data', f));
  if (f.endsWith('.zst')) b = zlib.zstdDecompressSync(b);
  const walk = (o) => {
    if (typeof o === 'string') strings.add(o.replace(/^models\//, '').replace(/\.glb$/, ''));
    else if (o && typeof o === 'object') for (const k of Object.keys(o)) { strings.add(k); walk(o[k]); }
  };
  walk(JSON.parse(b.toString('utf8')));
}
// the C++: string literals, and the prefixes / suffixes it joins names with
const prefixes = new Set(['']), suffixes = new Set(['']);
const walkSrc = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walkSrc(p);
    else if (/\.(cpp|h)$/.test(e.name)) {
      const src = fs.readFileSync(p, 'utf8');
      for (const m of src.matchAll(/"([A-Za-z0-9_\/.-]{2,64})"/g)) {
        const s = m[1];
        strings.add(s);
        if ((s.endsWith('/') || s.endsWith('_')) && /^[a-z]/.test(s)) prefixes.add(s);
        if (s.startsWith('_')) suffixes.add(s);
      }
    }
  }
};
walkSrc(path.join(native, 'src'));
for (const s of strings) for (const p of prefixes) for (const x of suffixes) { const n = p + s + x; if (exists(n)) found.add(n); }
// the LODs the loader picks up beside a model (<name>_lo)
for (const n of [...found]) if (exists(`${n}_lo`)) found.add(`${n}_lo`);

const list = [...found].sort();
fs.mkdirSync(path.dirname(out), { recursive: true });
const text = list.join('\n') + '\n';
if (!fs.existsSync(out) || fs.readFileSync(out, 'utf8') !== text) fs.writeFileSync(out, text);
let bytes = 0;
for (const n of list) bytes += fs.statSync(path.join(models, `${n}.glb`)).size;
console.log(`[models] ${list.length} models (${(bytes / 1048576).toFixed(1)} MB) -> ${path.relative(root, out)}`);
