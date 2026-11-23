// mend: one patch tool for every AI edit format.
//
// `node main.ts [options] [PATCH]` applies a patch in one of four formats
// (unified diff, SEARCH/REPLACE blocks, V4A, JSON edits) to the tree of text
// files rooted at the working directory. Every edit is applied or none is:
// a failed edit changes nothing, the edits after it still run, and when any
// edit failed no file is written at all. See SPEC.md for the contract.
//
// Node 22, standard library only. In a trial the grader runs this file with
// MAKEFUN_ENV_URL set, and the last lines hand over to runner.ts; keep them.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

interface Move {
  old: string;
  next: string;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Move[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  recordMove(old: string, next: string): void {
    this.moves.push({ old, next });
  }
}

type Edit = (tree: Tree) => void;

/** A file's lines, its line break, and whether it ends with one. */
interface FileShape {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileShape {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: FileShape): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

function leadingWs(s: string): string {
  let i = 0;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i += 1;
  return s.slice(0, i);
}

function normLine(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

interface Found {
  tier: number;
  occ: number[];
}

/** The occurrences of `oldLines` in `file` at the first tier where there is at least one. */
function findOccurrences(file: string[], oldLines: string[], strict: boolean, from: number): Found | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const want = oldLines.map((l) => normLine(l, t));
    const occ: number[] = [];
    for (let i = from; i + oldLines.length <= file.length; i += 1) {
      let ok = true;
      for (let j = 0; j < oldLines.length; j += 1) {
        if (normLine(file[i + j]!, t) !== want[j]) {
          ok = false;
          break;
        }
      }
      if (ok) occ.push(i);
    }
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of an edit: `ctx` lines are in both the old and the new text. */
interface LineItem {
  text: string;
  ctx: boolean;
}

/**
 * Build the replacement lines: a context line is written as the file's own
 * matched line, never the patch's; at tier 2 every other line is re-indented
 * from the old text's leading whitespace to the file's.
 */
function buildNew(nItems: LineItem[], oItems: LineItem[], fileLines: string[], pos: number, tier: number): string[] {
  const oCtxPos: number[] = [];
  oItems.forEach((it, idx) => {
    if (it.ctx) oCtxPos.push(idx);
  });
  const f = tier === 2 && oItems.length > 0 ? leadingWs(fileLines[pos]!) : '';
  const p = tier === 2 && oItems.length > 0 ? leadingWs(oItems[0]!.text) : '';
  const out: string[] = [];
  let seen = 0;
  for (const it of nItems) {
    if (it.ctx) {
      out.push(fileLines[pos + oCtxPos[seen]!]!);
      seen += 1;
    } else if (tier === 2 && !/^[ \t]*$/.test(it.text) && it.text.startsWith(p)) {
      out.push(f + it.text.slice(p.length));
    } else {
      out.push(it.text);
    }
  }
  return out;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const shape = splitFile(before);
      if (line < 0 || line > shape.lines.length) throw new Fail('no-match', p);
      const lines = [...shape.lines];
      lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile({ lines, br: shape.br, final: shape.final }));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** One hunk of a unified diff. */
interface Hunk {
  a: number;
  oItems: LineItem[];
  nItems: LineItem[];
  bsAfterLastCtxOrPlus: boolean;
  bsAfterLastPlus: boolean;
}

interface UniSection {
  diffOld: string | undefined;
  diffNew: string | undefined;
  dashOld: string | null | undefined;
  dashNew: string | null | undefined;
  renOld: string | undefined;
  renNew: string | undefined;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

/** The path of a `--- ` or `+++ ` line: text after the four characters, up to the first tab, trimmed. */
function dashPath(line: string): string | null {
  let rest = line.slice(4);
  const tab = rest.indexOf('\t');
  if (tab >= 0) rest = rest.slice(0, tab);
  const p = rest.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

interface RawBody {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
  empty: boolean;
}

/** Read one hunk body starting after the header at `at`; returns the hunk and the next line index. */
function parseHunk(lines: string[], at: number, a: number): { hunk: Hunk; next: number } {
  const raw: RawBody[] = [];
  let j = at + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      raw.push({ kind: 'ctx', text: '', empty: true });
      j += 1;
      continue;
    }
    const c = l[0]!;
    if (c === ' ') {
      raw.push({ kind: 'ctx', text: l.slice(1), empty: false });
      j += 1;
      continue;
    }
    if (c === '-') {
      raw.push({ kind: 'old', text: l.slice(1), empty: false });
      j += 1;
      continue;
    }
    if (c === '+') {
      raw.push({ kind: 'new', text: l.slice(1), empty: false });
      j += 1;
      continue;
    }
    if (c === '\\') {
      raw.push({ kind: 'bs', text: l.slice(1), empty: false });
      j += 1;
      continue;
    }
    break;
  }
  while (raw.length > 0 && raw[raw.length - 1]!.empty) raw.pop();
  const oItems: LineItem[] = [];
  const nItems: LineItem[] = [];
  for (const r of raw) {
    if (r.kind === 'ctx') {
      oItems.push({ text: r.text, ctx: true });
      nItems.push({ text: r.text, ctx: true });
    } else if (r.kind === 'old') {
      oItems.push({ text: r.text, ctx: false });
    } else if (r.kind === 'new') {
      nItems.push({ text: r.text, ctx: false });
    }
  }
  let lastCtxOrPlus = -1;
  let lastPlus = -1;
  raw.forEach((r, idx) => {
    if (r.kind === 'ctx' || r.kind === 'new') lastCtxOrPlus = idx;
    if (r.kind === 'new') lastPlus = idx;
  });
  const bsAfterLastCtxOrPlus = lastCtxOrPlus >= 0 && raw[lastCtxOrPlus + 1]?.kind === 'bs';
  const bsAfterLastPlus = lastPlus >= 0 && raw[lastPlus + 1]?.kind === 'bs';
  return { hunk: { a, oItems, nItems, bsAfterLastCtxOrPlus, bsAfterLastPlus }, next: j };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  const fresh = (): UniSection => ({
    diffOld: undefined,
    diffNew: undefined,
    dashOld: undefined,
    dashNew: undefined,
    renOld: undefined,
    renNew: undefined,
    isCreate: false,
    isDelete: false,
    hunks: [],
  });
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      sections.push(cur);
      inHeader = true;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1] ?? '';
      if (next.startsWith('+++ ')) {
        if (inHeader && cur !== null && cur.dashOld === undefined) {
          cur.dashOld = dashPath(line);
          cur.dashNew = dashPath(next);
          i += 2;
          continue;
        }
        cur = fresh();
        cur.dashOld = dashPath(line);
        cur.dashNew = dashPath(next);
        sections.push(cur);
        inHeader = true;
        i += 2;
        continue;
      }
      if (inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const parsed = parseHunk(lines, i, Number(m[1]));
      cur.hunks.push(parsed.hunk);
      i = parsed.next;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('+++ ')) {
        if (cur.dashNew === undefined) cur.dashNew = dashPath(line);
        i += 1;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renOld = line.slice(12).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renNew = line.slice(10).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.isCreate = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.isDelete = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => makeUnifiedEdit(sec, strict));
}

function uniPaths(sec: UniSection): { oldP: string | null | undefined; newP: string | null | undefined } {
  let oldP = sec.dashOld;
  if (oldP === undefined) oldP = sec.renOld;
  if (oldP === undefined) oldP = sec.diffOld;
  let newP = sec.dashNew;
  if (newP === undefined) newP = sec.renNew;
  if (newP === undefined) newP = sec.diffNew;
  if (oldP === undefined) oldP = newP;
  if (newP === undefined) newP = oldP;
  return { oldP, newP };
}

/** Apply a section's hunks in order, each to the result of the ones before it. */
function applyUniHunks(shape: FileShape, hunks: Hunk[], strict: boolean, path: string): FileShape {
  let lines = [...shape.lines];
  let final = shape.final;
  let d = 0;
  for (const h of hunks) {
    const O = h.oItems.map((it) => it.text);
    if (O.length === 0) {
      let at = h.a + d;
      if (at < 0) at = 0;
      if (at > lines.length) at = lines.length;
      const N = h.nItems.map((it) => it.text);
      const atEnd = at === lines.length;
      lines.splice(at, 0, ...N);
      d += N.length;
      if (atEnd) final = !h.bsAfterLastCtxOrPlus;
      continue;
    }
    const found = findOccurrences(lines, O, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.occ[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.occ) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const N = buildNew(h.nItems, h.oItems, lines, best, found.tier);
    const runsToEnd = best + O.length === lines.length;
    lines.splice(best, O.length, ...N);
    d += N.length - O.length;
    if (runsToEnd) final = !h.bsAfterLastCtxOrPlus;
  }
  return { lines, br: shape.br, final };
}

function makeUnifiedEdit(sec: UniSection, strict: boolean): Edit {
  const { oldP, newP } = uniPaths(sec);
  const isCreate = sec.isCreate || oldP === null;
  const isDelete = !isCreate && (sec.isDelete || newP === null);
  return (tree) => {
    if (oldP === undefined || newP === undefined) throw new Fail('missing', '');
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (isCreate) {
      const np = newP;
      if (np === null) throw new Fail('unsafe', '/dev/null');
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const newLines: string[] = [];
      for (const h of sec.hunks) {
        for (const it of h.nItems) if (!it.ctx) newLines.push(it.text);
      }
      let final = true;
      for (let k = sec.hunks.length - 1; k >= 0; k -= 1) {
        if (sec.hunks[k]!.nItems.some((it) => !it.ctx)) {
          final = !sec.hunks[k]!.bsAfterLastPlus;
          break;
        }
      }
      tree.now.set(np, newLines.length === 0 ? '' : newLines.join('\n') + (final ? '\n' : ''));
      return;
    }
    if (isDelete) {
      const op = oldP;
      if (op === null) throw new Fail('missing', '');
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    if (oldP !== newP) {
      const op = oldP!;
      const np = newP!;
      if (tree.get(op) === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const out = applyUniHunks(splitFile(tree.get(op)!), sec.hunks, strict, op);
      tree.now.set(np, joinFile(out));
      tree.now.set(op, null);
      tree.recordMove(op, np);
      return;
    }
    const p = oldP!;
    if (tree.get(p) === null) throw new Fail('missing', p);
    const out = applyUniHunks(splitFile(tree.get(p)!), sec.hunks, strict, p);
    tree.now.set(p, joinFile(out));
  };
}

function makeSREdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const shape = splitFile(cur);
    const found = findOccurrences(shape.lines, oldLines, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const oItems = oldLines.map((t) => ({ text: t, ctx: false }));
    const nItems = newLines.map((t) => ({ text: t, ctx: false }));
    const N = buildNew(nItems, oItems, shape.lines, pos, found.tier);
    const out = [...shape.lines];
    out.splice(pos, oldLines.length, ...N);
    tree.now.set(path, joinFile({ lines: out, br: shape.br, final: shape.final }));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let searchFrom = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j >= searchFrom; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine + 1}`);
    let eq = -1;
    let rep = -1;
    for (let j = searchLine + 1; j < lines.length; j += 1) {
      if (eq < 0 && lines[j]!.trimEnd() === '=======') {
        eq = j;
        continue;
      }
      if (eq >= 0 && lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(searchLine + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(makeSREdit(path, oldLines, newLines, strict));
    prevPath = path;
    searchFrom = rep + 1;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/** One chunk of a V4A Update File section. */
interface V4AChunk {
  anchor: string | null;
  oItems: LineItem[];
  nItems: LineItem[];
  eof: boolean;
}

function makeV4AAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function makeV4ADeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function makeV4AUpdateEdit(path: string, raw: string[], rawStart: number, headerLine: number, strict: boolean): Edit {
  let moveTo: string | null = null;
  const chunks: V4AChunk[] = [];
  let k = 0;
  if (raw.length > 0 && raw[0]!.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.slice(13).trim();
    k = 1;
  }
  let cur: V4AChunk | null = null;
  const startChunk = (anchor: string | null): void => {
    cur = { anchor, oItems: [], nItems: [], eof: false };
    chunks.push(cur);
  };
  while (k < raw.length) {
    const l = raw[k]!;
    const no = rawStart + k + 1;
    if (l.startsWith('@@')) {
      const a = l.slice(2).trim();
      startChunk(a === '' ? null : a);
      k += 1;
      continue;
    }
    if (l === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${no}`);
      cur.eof = true;
      cur = null;
      k += 1;
      continue;
    }
    if (l.startsWith('*** ')) throw new Exit2(`error: parse ${no}`);
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (cur === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${no}`);
        startChunk(null);
      }
      if (l === '') {
        cur!.oItems.push({ text: '', ctx: true });
        cur!.nItems.push({ text: '', ctx: true });
      } else if (l[0] === ' ') {
        const t = l.slice(1);
        cur!.oItems.push({ text: t, ctx: true });
        cur!.nItems.push({ text: t, ctx: true });
      } else if (l[0] === '-') {
        cur!.oItems.push({ text: l.slice(1), ctx: false });
      } else {
        cur!.nItems.push({ text: l.slice(1), ctx: false });
      }
      k += 1;
      continue;
    }
    throw new Exit2(`error: parse ${no}`);
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const curText = tree.get(path);
    if (curText === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const shape = splitFile(curText);
    let lines = [...shape.lines];
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const found = findOccurrences(lines, [ch.anchor], strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        cursor = found.occ[0]! + 1;
      }
      const O = ch.oItems.map((it) => it.text);
      if (O.length === 0) {
        const at = ch.eof ? lines.length : cursor;
        const N = ch.nItems.map((it) => it.text);
        lines.splice(at, 0, ...N);
        cursor = at + N.length;
        continue;
      }
      const found = findOccurrences(lines, O, strict, cursor);
      if (found === null) throw new Fail('no-match', path);
      let pos: number | null = null;
      for (const p of found.occ) {
        if (ch.eof && p + O.length !== lines.length) continue;
        pos = p;
        break;
      }
      if (pos === null) throw new Fail('no-match', path);
      const N = buildNew(ch.nItems, ch.oItems, lines, pos, found.tier);
      lines.splice(pos, O.length, ...N);
      cursor = pos + N.length;
    }
    const out = joinFile({ lines, br: shape.br, final: shape.final });
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      tree.recordMove(path, moveTo);
    } else {
      tree.now.set(path, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    while (i < last && blank(lines[i]!)) i += 1;
    if (i >= last) break;
    const line = lines[i]!;
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice(14).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice(17).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice(17).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const headerLine = i + 1;
    let j = i + 1;
    while (j < last) {
      const l = lines[j]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      j += 1;
    }
    const raw = lines.slice(i + 1, j);
    const rawStart = i + 1;
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (let k = 0; k < raw.length; k += 1) {
        const l = raw[k]!;
        if (l.startsWith('+')) fileLines.push(l.slice(1));
        else if (l === '') fileLines.push('');
        else throw new Exit2(`error: parse ${rawStart + k + 1}`);
      }
      edits.push(makeV4AAddEdit(path, fileLines));
    } else if (kind === 'delete') {
      for (let k = 0; k < raw.length; k += 1) {
        if (!blank(raw[k]!)) throw new Exit2(`error: parse ${rawStart + k + 1}`);
      }
      edits.push(makeV4ADeleteEdit(path));
    } else {
      edits.push(makeV4AUpdateEdit(path, raw, rawStart, headerLine, strict));
    }
    i = j;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  interface Row {
    key: string;
    line: string;
  }
  const rows: Row[] = [];
  const consumed = new Set<string>();
  for (const m of tree.moves) {
    const wasOld = tree.original(m.old);
    const nowOld = tree.get(m.old);
    const wasNew = tree.original(m.next);
    const nowNew = tree.get(m.next);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: m.next, line: `R ${m.old} -> ${m.next}` });
      consumed.add(m.old);
      consumed.add(m.next);
    }
  }
  for (const p of tree.now.keys()) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key), Buffer.from(y.key)));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    const ordered = [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    for (const p of ordered) {
      if (tree.now.get(p) === null) rmSync(p, { force: true });
    }
    for (const p of ordered) {
      const now = tree.now.get(p)!;
      if (now === null) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
