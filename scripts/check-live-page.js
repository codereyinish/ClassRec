#!/usr/bin/env node
/* Load-time sanity check for the live page's scripts.
 *
 * Three separate breakages have all had the same shape: a statement at the top
 * level touching something that is not ready yet — a deleted variable, or a
 * `const` declared further down. Either throws while the script is still
 * executing, so every handler below the failure is never bound. The page renders
 * perfectly and nothing works.
 *
 * A browser catches this instantly; without one, this does:
 *   1. syntax check
 *   2. undeclared identifiers used at the top level
 *   3. top-level reads of a `const`/`let` declared later (temporal dead zone)
 *
 * The script used to be one inline block; it is now five files. They are classic
 * scripts sharing one global scope, so what matters is the order live.html loads
 * them in — a binding declared in a later file does not exist yet for top-level
 * code in an earlier one. They are joined here in exactly that order, and every
 * line number is reported back as file:line.
 *
 * Run: node scripts/check-live-page.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// The order live.html loads them in. Changing it here without changing it there
// makes this check meaningless.
const FILES = [
    'live.js', 'audio-playback.js', 'voice-picker.js',
    'save-transcript.js', 'doubt-panel.js',
];

const origin = [null];              // concatenated line number -> "file:line"
let js = '';
for (const name of FILES) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'static', 'js', name), 'utf8');
    src.split('\n').forEach((_, i) => origin.push(`${name}:${i + 1}`));
    js += src + '\n';
}
const where = (n) => origin[n] || `line ${n}`;

/* Comments and string literals are blanked before anything is scanned, keeping
 * line numbers intact. Without this the checker reads prose: "a cursor passing
 * the corner" in a comment looked like reads of `a` and `cursor`, and 'ws://'
 * inside a URL looked like a read of `ws`. Six false alarms, one real fault —
 * which is how a checker gets ignored. */
function blankNoise(src) {
    let out = '', i = 0;
    const keep = (ch) => (out += ch === '\n' ? '\n' : ' ');
    while (i < src.length) {
        const c = src[i], n = src[i + 1];
        if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') keep(src[i++]); continue; }
        if (c === '/' && n === '*') { keep(src[i++]); keep(src[i++]);
            while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) keep(src[i++]);
            if (i < src.length) { keep(src[i++]); keep(src[i++]); } continue; }
        if (c === '"' || c === "'" || c === '`') {
            const q = c; keep(src[i++]);
            while (i < src.length && src[i] !== q) { if (src[i] === '\\') keep(src[i++]); keep(src[i++]); }
            if (i < src.length) keep(src[i++]);
            continue;
        }
        out += c; i++;
    }
    return out;
}

const code = blankNoise(js);
const lines = code.split('\n');

let failures = 0;
const fail = (msg) => { failures++; console.error('  ✗ ' + msg); };

// ---- 1. syntax -------------------------------------------------------------
try {
    new vm.Script(js);
    console.log('syntax: ok');
} catch (e) {
    console.error('syntax: FAILED');
    fail(e.message);
    process.exit(1);
}

// ---- collect declarations, with the line each is declared on ---------------
const declaredAt = new Map();          // name -> line number (1-based)
const KNOWN_GLOBALS = new Set([
    'window', 'document', 'navigator', 'location', 'localStorage', 'console',
    'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'fetch',
    'FormData', 'Blob', 'URL', 'AudioContext', 'WebSocket', 'Promise', 'JSON',
    'Math', 'Date', 'Array', 'Object', 'Set', 'Map', 'Int16Array', 'Float32Array',
    'Float64Array', 'Uint8Array', 'DataView', 'ArrayBuffer', 'MouseEvent',
    'FocusEvent', 'Event', 'IntersectionObserver', 'requestAnimationFrame',
    'cancelAnimationFrame', 'devicePixelRatio', 'addEventListener', 'alert',
    'isNaN', 'parseInt', 'parseFloat', 'encodeURIComponent', 'structuredClone',
    'matchMedia',   // a real global; without it the theme listener reads as a fault
]);
const KEYWORDS = new Set([
    'if', 'for', 'while', 'switch', 'try', 'catch', 'return', 'else', 'do',
    'typeof', 'new', 'await', 'throw', 'function', 'const', 'let', 'var', 'class',
]);

// A declaration can span several lines — `const a=1,\n  b=2;` — so each one is
// read from its keyword to its terminating semicolon, not line by line.
const lineOf = (index) => code.slice(0, index).split('\n').length;
for (const m of code.matchAll(/(?:^|[\s;{}])(?:const|let|var)\s+([\s\S]*?);\s*$/gm)) {
    const at = lineOf(m.index);
    for (const n of m[1].matchAll(/(?:^|,)\s*([A-Za-z_$][\w$]*)\s*(?==|,|$)/g)) {
        if (!declaredAt.has(n[1])) declaredAt.set(n[1], at);
    }
}
for (const m of code.matchAll(/(?:^|[\s;{}])(?:async\s+)?function\s+([\w$]+)/g)) {
    declaredAt.set(m[1], 0);        // hoisted: safe to call from anywhere
}

// ---- 2 + 3. top-level statements only (column 0) ---------------------------
lines.forEach((line, i) => {
    if (/^\s/.test(line) || !line.trim()) return;          // indented = inside a block
    if (/^(?:function|async|\/\/|\/\*|\*)/.test(line)) return;

    // A declaration's own initialiser runs immediately, so it is checked too —
    // `const SAMPLES_PER_BAR = SR / BARS_PER_SEC;` reads SR right now. Only the
    // right-hand side is scanned, so the names being declared are not flagged
    // against themselves. Arrow bodies are deferred, so they are exempt.
    let scan = line;
    if (/^(?:const|let|var)\s/.test(line)) {
        const eq = line.indexOf('=');
        if (eq < 0) return;
        scan = line.slice(eq + 1);
        if (/=>/.test(scan)) return;      // body runs when called, not now
    }

    for (const m of scan.matchAll(/([A-Za-z_$][\w$]*)/g)) {
        const name = m[1];
        if (KEYWORDS.has(name) || KNOWN_GLOBALS.has(name)) continue;
        if (/[.'"]\s*$/.test(scan.slice(0, m.index))) continue;   // property access
        // `{ enrolling: [...] }` is a key, not a read of the variable of that
        // name. A property position is a `{` or `,` before it and a `:` after.
        const before = scan.slice(0, m.index).trimEnd();
        const after  = scan.slice(m.index + name.length).trimStart();
        if (after.startsWith(':') && /[{,]$/.test(before)) continue;
        if (!declaredAt.has(name)) continue;                       // not ours
        const at = declaredAt.get(name);
        if (at > 0 && at > i + 1) {
            fail(`${where(i + 1)}: reads "${name}" but it is declared at ${where(at)} `
               + `— temporal dead zone, throws at load`);
        }
    }
});

// names used at the top level that nothing declares at all
lines.forEach((line, i) => {
    if (/^\s/.test(line)) return;
    const m = line.match(/^([A-Za-z_$][\w$]*)\s*[.[(]/);
    if (!m) return;
    const name = m[1];
    if (KEYWORDS.has(name) || KNOWN_GLOBALS.has(name) || declaredAt.has(name)) return;
    fail(`${where(i + 1)}: "${name}" is not declared anywhere — throws at load`);
});

if (failures) {
    console.error(`\n${failures} problem(s) that would stop the page binding handlers.`);
    process.exit(1);
}
console.log('top-level: ok — nothing reads a binding before it exists');
