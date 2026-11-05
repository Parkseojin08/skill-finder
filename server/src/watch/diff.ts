// Line diff of two SKILL.md texts in unified form (feature review F6 "차이 보기"). Myers' algorithm on the part
// between the common first and last lines, with a budget on the edit distance so the time stays in proportion to
// the input (D#4de9): past the budget the middle is shown as removed then added, which is still a correct diff.

export type DiffResult = {
  /** Unified diff text (`--- a`, `+++ b`, `@@ … @@` hunks); empty when the texts are the same. */
  text: string;
  added: number;
  removed: number;
  /** The output was cut at `maxLines`. */
  truncated: boolean;
  /** Too different for a line-by-line match within the budget: the changed middle is one remove-then-add block. */
  approximate: boolean;
};

type Op = { t: ' ' | '-' | '+'; a: number; b: number };

/** Lines as the files hold them, line endings aside; a final newline does not make an empty last line. */
export function splitLines(text: string): string[] {
  const s = text.replace(/\r\n?/g, '\n');
  if (s === '') return [];
  const lines = s.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/** Edit ops between `a` and `b` (numbers standing for lines), or null past `maxD` edits. */
function myers(a: Int32Array, b: Int32Array, maxD: number): Op[] | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, maxD);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  // the furthest x per diagonal before each round, only the diagonals that round can read ([-d, d])
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(off - d, off + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, d, n, m);
    }
  }
  return null;
}

function backtrack(trace: Int32Array[], dEnd: number, n: number, m: number): Op[] {
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = dEnd; d > 0; d--) {
    const prev = trace[d]; // state after round d-1, indexed k + d
    const at = (k: number) => prev[k + d];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      ops.push({ t: ' ', a: x, b: y });
    }
    if (prevK === k + 1) ops.push({ t: '+', a: x, b: prevY });
    else ops.push({ t: '-', a: prevX, b: y });
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    ops.push({ t: ' ', a: x, b: y });
  }
  return ops.reverse();
}

/** Edit budget: exact for anything SKILL.md-sized, a few dozen edits for half a megabyte of lines (~2e7 steps). */
const budget = (lines: number) => Math.min(1000, Math.max(50, Math.floor(2e7 / Math.max(1, lines))));
const MAX_LINE_CHARS = 1000;
const clip = (s: string) => (s.length > MAX_LINE_CHARS ? `${s.slice(0, MAX_LINE_CHARS)}…` : s);

export function unifiedDiff(
  aText: string,
  bText: string,
  opts: { labelA?: string; labelB?: string; context?: number; maxLines?: number } = {},
): DiffResult {
  const context = opts.context ?? 3;
  const maxLines = opts.maxLines ?? 3000;
  const a = splitLines(aText);
  const b = splitLines(bText);
  // lines as numbers, so the inner loop compares integers
  const ids = new Map<string, number>();
  const num = (s: string) => {
    let i = ids.get(s);
    if (i === undefined) ids.set(s, (i = ids.size));
    return i;
  };
  const an = Int32Array.from(a, num);
  const bn = Int32Array.from(b, num);
  let pre = 0;
  while (pre < an.length && pre < bn.length && an[pre] === bn[pre]) pre++;
  let suf = 0;
  while (suf < an.length - pre && suf < bn.length - pre && an[an.length - 1 - suf] === bn[bn.length - 1 - suf]) suf++;
  const am = an.subarray(pre, an.length - suf);
  const bm = bn.subarray(pre, bn.length - suf);
  let mid = myers(am, bm, budget(am.length + bm.length));
  const approximate = mid == null;
  if (!mid) {
    mid = [];
    for (let i = 0; i < am.length; i++) mid.push({ t: '-', a: i, b: 0 });
    for (let j = 0; j < bm.length; j++) mid.push({ t: '+', a: am.length, b: j });
  }
  const ops: Op[] = [];
  for (let i = 0; i < pre; i++) ops.push({ t: ' ', a: i, b: i });
  for (const o of mid) ops.push({ t: o.t, a: o.a + pre, b: o.b + pre });
  for (let i = 0; i < suf; i++) ops.push({ t: ' ', a: an.length - suf + i, b: bn.length - suf + i });

  let added = 0;
  let removed = 0;
  for (const o of ops) {
    if (o.t === '+') added++;
    else if (o.t === '-') removed++;
  }
  if (added === 0 && removed === 0) return { text: '', added, removed, truncated: false, approximate: false };

  // hunks: runs of changes with `context` equal lines around them, merged when they touch
  const out = [`--- ${opts.labelA ?? 'a'}`, `+++ ${opts.labelB ?? 'b'}`];
  let truncated = false;
  let i = 0;
  while (i < ops.length && !truncated) {
    while (i < ops.length && ops[i].t === ' ') i++;
    if (i >= ops.length) break;
    const start = Math.max(0, i - context);
    let end = i;
    for (;;) {
      while (end < ops.length && ops[end].t !== ' ') end++;
      let next = end;
      while (next < ops.length && ops[next].t === ' ') next++;
      if (next < ops.length && next - end <= 2 * context) end = next;
      else {
        end = Math.min(ops.length, end + context);
        break;
      }
    }
    const hunk = ops.slice(start, end);
    // where the hunk starts in each text: the first op's line there (a '+' sits before a-line `a`, a '-' before b-line `b`)
    const aStart = hunk[0].a;
    const bStart = hunk[0].b;
    const aCount = hunk.filter((o) => o.t !== '+').length;
    const bCount = hunk.filter((o) => o.t !== '-').length;
    out.push(`@@ -${aCount ? aStart + 1 : aStart},${aCount} +${bCount ? bStart + 1 : bStart},${bCount} @@`);
    for (const o of hunk) {
      if (out.length >= maxLines) {
        truncated = true;
        break;
      }
      out.push(o.t + clip(o.t === '+' ? b[o.b] : a[o.a]));
    }
    i = end;
  }
  return { text: out.join('\n'), added, removed, truncated, approximate };
}
