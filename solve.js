// A faster drop-in for makefun-site 1.0.0: run(input) returns exactly what makefun-site 1.0.0's build returns.
// Same rules, written for speed: single-pass scans instead of per-line and per-character regular expressions, and
// templates compiled to plain functions. No dependencies.

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped (fast: returns the string itself when nothing needs escaping). */
function escapeHtml(text) {
  ESC_RE.lastIndex = 0;
  const m = ESC_RE.exec(text);
  if (m === null) return text;
  let out = text.slice(0, m.index) + ESCAPES[m[0]];
  let last = ESC_RE.lastIndex;
  while (true) {
    const n = ESC_RE.exec(text);
    if (n === null) break;
    out += text.slice(last, n.index) + ESCAPES[n[0]];
    last = ESC_RE.lastIndex;
  }
  return out + text.slice(last);
}

const SLUG_MAX = 64;
const NON_ASCII = /[^\x00-\x7F]/;
const COMBINING = /\p{M}/gu;
const TRAILING_DASH = /-+$/;

/** makefun-site's slug rule (README.md, "Text"). */
function slugify(text) {
  let plain = text;
  if (NON_ASCII.test(plain)) plain = plain.normalize('NFKD').replace(COMBINING, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = 0;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === 0) {
      // any character outside a-z 0-9: one separator; NFKD may leave non-ASCII, which the code-unit walk treats the same
      const ch = plain[i];
      const isAZ = ch >= 'A' && ch <= 'Z';
      if (!isAZ) { gap = out.length > 0; continue; }
    }
    if (keep === 0) continue;
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  out = out.slice(0, SLUG_MAX).replace(TRAILING_DASH, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** Whether `c` (a code unit) is JavaScript's \s. */
function isSpace(c) {
  return c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

/** The words of a body: its runs of characters other than whitespace. Scans without allocating. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (isSpace(text.charCodeAt(i))) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

// countWords: same as wordsOf, named for the per-line counting inside renderMarkdown.
const countWords = wordsOf;

// ---------------------------------------------------------------- front matter

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;
const TRAIL_WS = /[ \t]+$/;
const LEAD_WS = /^[ \t]+/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE_RE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) if (t === '' || !TAG_RE.test(t)) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

/**
 * A source's front matter and body: { data, body }, or { error }. `text` has "\n" line ends.
 * Scans in place: no split, no per-line arrays.
 */
function parseFrontMatter(text) {
  const n = text.length;
  // first line must be exactly ---
  let eol = text.indexOf('\n');
  const firstLen = eol === -1 ? n : eol;
  if (text.slice(0, firstLen) !== '---') return { error: 'no front matter' };
  if (eol === -1) return { error: 'the front matter is not closed' };
  let pos = eol + 1;
  let lineNo = 1; // number of the line that starts at pos, counting the opening --- as 1
  // find the closing --- first, so a line beyond it is never read as front matter
  let scan = pos;
  let close = -1;
  let closeStart = -1;
  while (scan <= n) {
    const e = text.indexOf('\n', scan);
    const len = e === -1 ? n - scan : e - scan;
    if (len === 3 && text.charCodeAt(scan) === 45 && text.charCodeAt(scan + 1) === 45 && text.charCodeAt(scan + 2) === 45) {
      close = scan;
      closeStart = scan;
      break;
    }
    if (e === -1) break;
    scan = e + 1;
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  while (pos < close) {
    const e = text.indexOf('\n', pos);
    const len = (e === -1 || e > close ? close : e) - pos;
    const line = text.slice(pos, pos + len);
    lineNo++;
    pos = pos + len + 1;
    if (len === 0) continue;
    const c0 = line.charCodeAt(0);
    if (c0 === 35) continue; // comment
    if (c0 === 32 || c0 === 9) {
      if (/^[ \t]*$/.test(line)) continue;
      return { error: `line ${lineNo} is not "key: value"` };
    }
    // key: value, key of a-z and _
    let k = 0;
    while (k < len) {
      const cc = line.charCodeAt(k);
      if ((cc >= 97 && cc <= 122) || cc === 95) k++;
      else break;
    }
    if (k === 0 || k >= len || line.charCodeAt(k) !== 58) return { error: `line ${lineNo} is not "key: value"` };
    const key = line.slice(0, k);
    let raw = '';
    if (k + 1 < len && line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2).replace(TRAIL_WS, '');
    else if (k + 1 < len) return { error: `line ${lineNo} is not "key: value"` };
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  // body: everything after the closing line's newline
  const after = text.indexOf('\n', closeStart);
  const body = after === -1 ? '' : text.slice(after + 1);
  return { data, body };
}

// ---------------------------------------------------------------- markdown

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const INLINE_RE = /[\\`*\[&<>"']/g;

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  const wlen = what.length;
  for (let j = from; j <= s.length - wlen; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

const WS_ANY = /\s/;

/** `s` rendered inline; `env.link(target)` is a link's href. One scan for both specials and escaped characters. */
function inline(s, env) {
  let out = '';
  let i = 0;
  const n = s.length;
  let chunk = 0; // start of the plain run being accumulated
  while (i < n) {
    INLINE_RE.lastIndex = i;
    const m = INLINE_RE.exec(s);
    if (m === null) {
      out += s.slice(chunk);
      break;
    }
    i = m.index;
    if (i > chunk) out += s.slice(chunk, i);
    const code = s.charCodeAt(i);
    if (code === 38) {
      out += '&amp;';
      i++;
    } else if (code === 60) {
      out += '&lt;';
      i++;
    } else if (code === 62) {
      out += '&gt;';
      i++;
    } else if (code === 34) {
      out += '&quot;';
      i++;
    } else if (code === 39) {
      out += '&#39;';
      i++;
    } else if (code === 92) {
      if (i + 1 < n && ESCAPABLE.has(s[i + 1])) {
        out += escapeHtml(s[i + 1]);
        i += 2;
      } else {
        out += '\\';
        i++;
      }
    } else if (code === 96) {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        out += `<code>${escapeHtml(s.slice(i + 1, j))}</code>`;
        i = j + 1;
      } else {
        out += '`';
        i++;
      }
    } else if (code === 42) {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          out += `<strong>${inline(s.slice(i + 2, j), env)}</strong>`;
          i = j + 2;
        } else {
          out += '**';
          i += 2;
        }
      } else {
        const j = findSingleStar(s, i + 1);
        if (j > i + 1) {
          out += `<em>${inline(s.slice(i + 1, j), env)}</em>`;
          i = j + 1;
        } else {
          out += '*';
          i++;
        }
      }
    } else {
      // '['
      const k = findUnescaped(s, ']', i + 1);
      const mIdx = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = mIdx === -1 ? '' : s.slice(k + 2, mIdx);
      if (target !== '' && !WS_ANY.test(target)) {
        out += `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(i + 1, k), env)}</a>`;
        i = mIdx + 1;
      } else {
        out += '[';
        i++;
      }
    }
    chunk = i;
  }
  return out;
}

/** A heading line's level and text, or null (a heading's text is never empty). Line has no "\n". */
function headingOf(line) {
  const n = line.length;
  let h = 0;
  while (h < n && line.charCodeAt(h) === 35) h++;
  if (h === 0 || h > 6 || h >= n) return null;
  const c = line.charCodeAt(h);
  if (c !== 32 && c !== 9) return null;
  let a = h;
  while (a < n && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  let b = n;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  const text = line.slice(a, b);
  return text === '' ? null : { depth: h, text };
}

/** trim spaces and tabs at both ends */
function trimLine(line) {
  let a = 0;
  const n = line.length;
  let b = n;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

const FENCE_LANG = /^[A-Za-z0-9_+-]*[ \t]*$/;

/** A fence-opening line's language, or null. */
function fenceOpenOf(line) {
  if (!line.startsWith('```')) return null;
  const rest = line.slice(3);
  return FENCE_LANG.test(rest) ? rest.replace(TRAIL_WS, '') : null;
}

/** Whether a line closes a fence: ``` then spaces or tabs only. */
function isFenceClose(line) {
  if (!line.startsWith('```')) return false;
  const rest = line.slice(3);
  return /^[ \t]*$/.test(rest);
}

/** A thematic break: --- or *** then spaces or tabs only. */
function isHr(line) {
  if (line.startsWith('---')) return /^[ \t]*$/.test(line.slice(3));
  if (line.startsWith('***')) return /^[ \t]*$/.test(line.slice(3));
  return false;
}

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

const BULLET_RE = /^[-*] (.*)$/;
const ORDERED_RE = /^(\d{1,9})\. (.*)$/;
const CONTINUED_RE = /^ {2,}\S/;
const LANG_CLASS = (lang) => (lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`);

/**
 * `src` rendered: its HTML, table of contents (level 2 and 3 headings) and excerpt (the first paragraph's HTML).
 * Cursor-based line scanner; no token tree, no line array.
 */
function renderMarkdown(src, env) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let words = 0; // the body's words (runs of non-whitespace), counted as lines are consumed
  const n = src.length;

  let p = 0;
  while (p <= n) {
    let e = src.indexOf('\n', p);
    let after;
    if (e === -1) {
      e = n;
      after = -1;
    } else after = e + 1;
    const line = src.slice(p, e);
    if (isBlank(line)) {
      if (after === -1) break;
      p = after;
      continue;
    }
    const fence = fenceOpenOf(line);
    if (fence !== null) {
      words += countWords(line);
      let body = '';
      p = after;
      while (p !== -1) {
        let e2 = src.indexOf('\n', p);
        if (e2 === -1) e2 = n;
        const l2 = src.slice(p, e2);
        p = e2 === n ? -1 : e2 + 1;
        words += countWords(l2);
        if (isFenceClose(l2)) break;
        body += `${escapeHtml(l2)}\n`;
      }
      blocks.push(`<pre><code${LANG_CLASS(fence)}>${body}</code></pre>`);
      if (p === -1) break;
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      words += countWords(line);
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = inline(heading.text, env);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      if (after === -1) break;
      p = after;
      continue;
    }
    if (isHr(line)) {
      words += countWords(line);
      blocks.push('<hr>');
      if (after === -1) break;
      p = after;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      // blockquote: consecutive lines opening on >
      const items = [];
      while (p !== -1) {
        let e2 = src.indexOf('\n', p);
        if (e2 === -1) e2 = n;
        const l2 = src.slice(p, e2);
        if (l2.charCodeAt(0) !== 62) break;
        words += countWords(l2);
        let l = l2.slice(1);
        if (l.charCodeAt(0) === 32) l = l.slice(1);
        const t = trimLine(l);
        if (t !== '') items.push(t);
        p = e2 === n ? -1 : e2 + 1;
      }
      blocks.push(items.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(items.join('\n'), env)}</p>\n</blockquote>`);
      if (p === -1) break;
      continue;
    }
    const bullet = BULLET_RE.exec(line);
    const ordered = bullet === null ? ORDERED_RE.exec(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const marker = isOrdered ? ORDERED_RE : BULLET_RE;
      const items = [];
      while (p !== -1) {
        let e2 = src.indexOf('\n', p);
        if (e2 === -1) e2 = n;
        const l2 = src.slice(p, e2);
        const m = marker.exec(l2);
        if (m !== null) {
          words += countWords(l2);
          items.push([trimLine(isOrdered ? m[2] : m[1])]);
          p = e2 === n ? -1 : e2 + 1;
        } else if (items.length > 0 && CONTINUED_RE.test(l2)) {
          words += countWords(l2);
          items[items.length - 1].push(trimLine(l2));
          p = e2 === n ? -1 : e2 + 1;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const start = isOrdered ? Number(ordered[1]) : 1;
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      let body = '';
      for (const parts of items) body += `<li>${inline(parts.join('\n'), env)}</li>\n`;
      blocks.push(`${open}\n${body}</${tag}>`);
      if (p === -1) break;
      continue;
    }
    // paragraph
    words += countWords(line);
    let text = trimLine(line);
    p = after;
    while (p !== -1) {
      let e2 = src.indexOf('\n', p);
      if (e2 === -1) e2 = n;
      const l2 = src.slice(p, e2);
      if (isBlank(l2) || fenceOpenOf(l2) !== null || headingOf(l2) !== null || isHr(l2)) break;
      words += countWords(l2);
      text += `\n${trimLine(l2)}`;
      p = e2 === n ? -1 : e2 + 1;
    }
    const html = inline(text, env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
    if (p === -1) break;
  }
  let out = '';
  for (const b of blocks) out += `${b}\n`;
  return { html: out, toc, excerpt: excerpt ?? '', words };
}

// ---------------------------------------------------------------- templates

const T_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const T_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const T_IF = /^if (not )?(\S+)$/;
const T_INCLUDE = /^include "([a-z0-9-]+)"$/;
const T_WS = /^[ \t]*$/;
const INCLUDE_DEPTH = 8;

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!T_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = T_WS.test(src.slice(lineStart, open)) && T_WS.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = T_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = T_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = T_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  const p0 = path[0];
  while (s !== null && !Object.hasOwn(s.vars, p0)) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[p0];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text. */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// Template rendering compiled: each parsed template becomes a function (scope, depth) => string, built once per
// build (never across cases) with the same semantics as makefun-site's renderNodes.

/**
 * Compile one template's nodes into JS source appended to `code`, writing into variable `out`.
 * `pathConsts` collects the deduped path arrays; `scopeExpr` names the current scope.
 */
function compileNodes(nodes, code, pathConsts, scopeExpr) {
  for (const nd of nodes) {
    switch (nd.kind) {
      case 'text':
        code.push(`out+=${JSON.stringify(nd.text)};`);
        break;
      case 'var':
      case 'raw': {
        const key = nd.path.join('.');
        let idx = pathConsts.indexOf(key);
        if (idx === -1) {
          pathConsts.push(key);
          idx = pathConsts.length - 1;
        }
        code.push(nd.kind === 'var' ? `out+=h.esc(h.tx(h.lk(${scopeExpr},P${idx})));` : `out+=h.tx(h.lk(${scopeExpr},P${idx}));`);
        break;
      }
      case 'if': {
        const key = nd.path.join('.');
        let idx = pathConsts.indexOf(key);
        if (idx === -1) {
          pathConsts.push(key);
          idx = pathConsts.length - 1;
        }
        const cond = `h.tr(h.lk(${scopeExpr},P${idx}))`;
        code.push(`if(${nd.not ? '!' : ''}(${cond})){`);
        compileNodes(nd.then, code, pathConsts, scopeExpr);
        if (nd.else !== null) {
          code.push('}else{');
          compileNodes(nd.else, code, pathConsts, scopeExpr);
        }
        code.push('}');
        break;
      }
      case 'for': {
        const key = nd.path.join('.');
        let idx = pathConsts.indexOf(key);
        if (idx === -1) {
          pathConsts.push(key);
          idx = pathConsts.length - 1;
        }
        const s2 = `${scopeExpr}a`;
        const lp = `${scopeExpr}l`;
        code.push(`{const xs=h.lk(${scopeExpr},P${idx});if(Array.isArray(xs)){const xl=xs.length;const ${lp}={index:0,first:false,last:false,length:xl};`);
        code.push(`for(let k=0;k<xl;k++){${lp}.index=k+1;${lp}.first=k===0;${lp}.last=k===xl-1;const ${s2}={vars:{${JSON.stringify(nd.name)}:xs[k],loop:${lp}},parent:${scopeExpr}};`);
        compileNodes(nd.body, code, pathConsts, s2);
        code.push('}}}');
        break;
      }
      case 'include':
        code.push(`{const f=T.get(${JSON.stringify(nd.name)});if(f!==undefined&&depth<${INCLUDE_DEPTH})out+=f(${scopeExpr},depth+1);}`);
        break;
    }
  }
}

/** Compile the parsed templates (Map name -> nodes) into a Map name -> render function. */
function compileTemplates(parsed) {
  const pathConsts = [];
  const parts = [];
  const names = [];
  for (const [name, nodes] of parsed) {
    const code = [];
    compileNodes(nodes, code, pathConsts, 'scope');
    parts.push(`${JSON.stringify(name)}:function(scope,depth){let out='';${code.join('')}return out;}`);
    names.push(name);
  }
  const consts = pathConsts.map((p, i) => `const P${i}=${JSON.stringify(p.split('.'))};`).join('');
  const T = new Map();
  const factory = new Function('h', 'T', `${consts}return {${parts.join(',')}};`);
  const fns = factory({ lk: lookup, tx: textOf, tr: truthy, esc: escapeHtml }, T);
  for (const name of names) T.set(name, fns[name]);
  return T;
}

// ---------------------------------------------------------------- the build

const RESERVED = ['posts', 'tags', 'page'];
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const CRLF = /\r\n?/g;

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** `rel` from the directory whose parts are `dirParts` (not mutated), or null when it climbs out of the root. */
function resolvePathParts(dirParts, rel) {
  const parts = dirParts.slice();
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => {
  const k = path.lastIndexOf('/');
  return k === -1 ? '' : path.slice(0, k);
};

/** One site's output tree: path -> text. Exactly makefun-site 1.0.0's build, faster. */
export function run(input) {
  const report = [];
  // 2. templates parsed in code-unit order of their names
  const parsed = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      parsed.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const templateNames = new Set(parsed.keys());
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. sources sorted by path; .md sources normalized, the rest static
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(CRLF, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // front matter and the refusal checks, in makefun-site's order
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templateNames.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  sources = kept;

  // permalinks
  const taken = new Map();
  const takenIn = (dir) => {
    let t = taken.get(dir);
    if (t === undefined) {
      t = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, t);
    }
    return t;
  };
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // markdown
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of sources) {
    const dir = dirOf(s.path);
    const dirParts = dir === '' ? [] : dir.split('/');
    const env = {
      link: (target) => {
        if (SCHEME.test(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePathParts(dirParts, rel);
        if (path !== null) {
          const hit = bySource.get(path);
          if (hit !== undefined) return `${hit.url}${frag}`;
          if (staticPaths.has(path)) return `${base}/${path}${frag}`;
        }
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = md.words;
  }

  // collections
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // tags
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    const list = s.data.tags ?? [];
    for (const name of list) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push([name, slug]);
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const [name, slug] of ownTags(p)) {
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map(([name, slug]) => bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
  }
  const allTagsSorted = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // cards and pages as templates read them
  const linkOf = (s) => (s === null || s === undefined ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const pageOf = (s) => {
    const c = { ...s.card };
    c.slug = s.slug;
    c.content = s.html;
    c.toc = s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html }));
    c.newer = linkOf(s.newer ?? null);
    c.older = linkOf(s.older ?? null);
    c.is_post = s.post;
    return c;
  };

  for (const s of sources) s.card = cardOf(s);
  const cards = new Map(posts.map((p) => [p, p.card]));
  const site = { title: input.site.title, base_url: base };
  const allTags = allTagsSorted.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const T = compileTemplates(parsed);
  const render = (name, vars) => {
    const f = T.get(name);
    if (f === undefined) return null;
    return f({ vars: { site, tags: allTags, recent, ...vars }, parent: null }, 0);
  };

  const output = {};
  for (const s of sources) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of allTagsSorted) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // the report
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${allTagsSorted.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
  }
