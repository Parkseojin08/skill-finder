// A small TOML reader for the agent config view (feature review F10): enough of TOML 1.0 for Codex's
// ~/.codex/config.toml — tables, arrays of tables, dotted and quoted keys, strings of all four kinds, numbers,
// booleans, dates (kept as text), arrays and inline tables. One pass over the text, no regular expression that can
// backtrack, nesting depth capped: a hostile file costs time in proportion to its length (D#4de9).

export class TomlError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(`${message} (line ${line})`);
    this.line = line;
  }
}

export type TomlTable = { [key: string]: unknown };

export type TomlResult = {
  data: TomlTable;
  /** The line of each `[table]` header, by its dotted path as written ("mcp_servers.node_repl"). */
  tableLines: Map<string, number>;
};

const MAX_DEPTH = 64;

/** Set as an own property: a key named `__proto__` must not change the object's prototype. */
function setKey(t: TomlTable, k: string, v: unknown): void {
  Object.defineProperty(t, k, { value: v, writable: true, enumerable: true, configurable: true });
}

const isBare = (c: string) => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '_' || c === '-';
const isValueChar = (c: string) => c !== '' && c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r' && c !== ',' && c !== ']' && c !== '}' && c !== '#';

export function parseToml(text: string): TomlResult {
  let i = 0;
  let line = 1;
  const n = text.length;
  const data: TomlTable = {};
  const tableLines = new Map<string, number>();
  let current: TomlTable = data;

  const peek = (k = 0) => (i + k < n ? text[i + k] : '');
  const fail = (msg: string): never => {
    throw new TomlError(msg, line);
  };
  const skipSpaces = () => {
    while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
  };
  const skipComment = () => {
    if (peek() === '#') while (i < n && text[i] !== '\n') i++;
  };
  /** Spaces, comments and line breaks (inside arrays, and between statements). */
  const skipBlank = () => {
    for (;;) {
      skipSpaces();
      skipComment();
      if (peek() === '\n') {
        i++;
        line++;
      } else if (peek() === '\r' && peek(1) === '\n') {
        i += 2;
        line++;
      } else return;
    }
  };
  const endOfLine = () => {
    skipSpaces();
    skipComment();
    if (i >= n) return;
    if (peek() === '\n') {
      i++;
      line++;
    } else if (peek() === '\r' && peek(1) === '\n') {
      i += 2;
      line++;
    } else fail('줄 끝에 남은 글자');
  };

  const escape = (): string => {
    const c = peek();
    i++;
    switch (c) {
      case 'b':
        return '\b';
      case 't':
        return '\t';
      case 'n':
        return '\n';
      case 'f':
        return '\f';
      case 'r':
        return '\r';
      case 'e':
        return '\x1b';
      case '"':
        return '"';
      case '\\':
        return '\\';
      case 'u':
      case 'U': {
        const len = c === 'u' ? 4 : 8;
        const hex = text.slice(i, i + len);
        if (hex.length !== len || !/^[0-9A-Fa-f]+$/.test(hex)) fail('잘못된 \\u 이스케이프');
        i += len;
        const cp = parseInt(hex, 16);
        if (cp > 0x10ffff) fail('잘못된 코드 포인트');
        return String.fromCodePoint(cp);
      }
      default:
        return fail('알 수 없는 이스케이프');
    }
  };

  const basicString = (): string => {
    i++; // "
    let out = '';
    for (;;) {
      if (i >= n) fail('닫히지 않은 문자열');
      const c = text[i];
      if (c === '"') {
        i++;
        return out;
      }
      if (c === '\n') fail('문자열 안의 줄 바꿈');
      if (c === '\\') {
        i++;
        out += escape();
      } else {
        out += c;
        i++;
      }
    }
  };
  const literalString = (): string => {
    i++; // '
    const start = i;
    while (i < n && text[i] !== "'" && text[i] !== '\n') i++;
    if (peek() !== "'") fail('닫히지 않은 문자열');
    const out = text.slice(start, i);
    i++;
    return out;
  };
  const multiline = (quote: '"' | "'"): string => {
    i += 3;
    // a line break right after the opening quotes is not part of the text
    if (peek() === '\n') {
      i++;
      line++;
    } else if (peek() === '\r' && peek(1) === '\n') {
      i += 2;
      line++;
    }
    let out = '';
    for (;;) {
      if (i >= n) fail('닫히지 않은 여러 줄 문자열');
      const c = text[i];
      if (c === quote && peek(1) === quote && peek(2) === quote) {
        i += 3;
        // up to two more quotes belong to the text ("""a""""" is a"")
        let extra = 0;
        while (extra < 2 && peek() === quote) {
          out += quote;
          i++;
          extra++;
        }
        return out;
      }
      if (c === '\n') line++;
      if (quote === '"' && c === '\\') {
        i++;
        // a backslash at the end of a line trims the break and the spaces after it
        let j = i;
        while (j < n && (text[j] === ' ' || text[j] === '\t')) j++;
        if (text[j] === '\n' || (text[j] === '\r' && text[j + 1] === '\n')) {
          i = j;
          while (i < n && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) {
            if (text[i] === '\n') line++;
            i++;
          }
          continue;
        }
        out += escape();
        continue;
      }
      out += c;
      i++;
    }
  };

  const keyPart = (): string => {
    const c = peek();
    if (c === '"') return basicString();
    if (c === "'") return literalString();
    const start = i;
    while (i < n && isBare(text[i])) i++;
    if (i === start) fail('키가 없음');
    return text.slice(start, i);
  };
  const dottedKey = (): string[] => {
    const parts = [keyPart()];
    for (;;) {
      skipSpaces();
      if (peek() !== '.') return parts;
      i++;
      skipSpaces();
      parts.push(keyPart());
    }
  };

  const scalar = (): unknown => {
    const start = i;
    while (i < n && isValueChar(text[i])) i++;
    // a date and time may be written with a space between them
    if (i < n && text[i] === ' ' && /^\d{4}-\d{2}-\d{2}$/.test(text.slice(start, i)) && /\d/.test(peek(1))) {
      i++;
      while (i < n && isValueChar(text[i])) i++;
    }
    const raw = text.slice(start, i);
    if (!raw) fail('값이 없음');
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (raw === 'inf' || raw === '+inf') return Infinity;
    if (raw === '-inf') return -Infinity;
    if (raw === 'nan' || raw === '+nan' || raw === '-nan') return NaN;
    const num = raw.replace(/_/g, '');
    if (/^[+-]?(\d+)(\.\d+)?([eE][+-]?\d+)?$/.test(num)) return Number(num);
    if (/^0x[0-9A-Fa-f]+$/.test(num)) return parseInt(num.slice(2), 16);
    if (/^0o[0-7]+$/.test(num)) return parseInt(num.slice(2), 8);
    if (/^0b[01]+$/.test(num)) return parseInt(num.slice(2), 2);
    if (/^\d{4}-\d{2}-\d{2}|^\d{2}:\d{2}/.test(raw)) return raw; // dates and times stay text
    return fail('알 수 없는 값');
  };

  const value = (depth: number): unknown => {
    if (depth > MAX_DEPTH) fail('너무 깊게 겹친 값');
    const c = peek();
    if (c === '"') return peek(1) === '"' && peek(2) === '"' ? multiline('"') : basicString();
    if (c === "'") return peek(1) === "'" && peek(2) === "'" ? multiline("'") : literalString();
    if (c === '[') {
      i++;
      const arr: unknown[] = [];
      for (;;) {
        skipBlank();
        if (peek() === ']') {
          i++;
          return arr;
        }
        if (i >= n) fail('닫히지 않은 배열');
        arr.push(value(depth + 1));
        skipBlank();
        if (peek() === ',') i++;
        else if (peek() === ']') {
          i++;
          return arr;
        } else fail('배열 안의 쉼표가 없음');
      }
    }
    if (c === '{') {
      i++;
      const table: TomlTable = {};
      skipSpaces();
      if (peek() === '}') {
        i++;
        return table;
      }
      for (;;) {
        skipSpaces();
        const key = dottedKey();
        skipSpaces();
        if (peek() !== '=') fail('= 가 없음');
        i++;
        skipSpaces();
        assign(table, key, value(depth + 1));
        skipSpaces();
        if (peek() === ',') i++;
        else if (peek() === '}') {
          i++;
          return table;
        } else fail('인라인 표가 닫히지 않음');
      }
    }
    return scalar();
  };

  /** The table at `path` under `root`, made when missing; an array of tables gives its last element. */
  const tableAt = (root: TomlTable, path: string[]): TomlTable => {
    let t = root;
    for (const k of path) {
      let next = Object.prototype.hasOwnProperty.call(t, k) ? t[k] : undefined;
      if (next === undefined) {
        next = {};
        setKey(t, k, next);
      }
      if (Array.isArray(next)) next = next[next.length - 1];
      if (!next || typeof next !== 'object') fail(`표가 아닌 키: ${k}`);
      t = next as TomlTable;
    }
    return t;
  };
  const assign = (root: TomlTable, key: string[], v: unknown) => {
    const t = tableAt(root, key.slice(0, -1));
    setKey(t, key[key.length - 1], v);
  };

  for (;;) {
    skipBlank();
    if (i >= n) break;
    if (peek() === '[') {
      const startLine = line;
      const isArray = peek(1) === '[';
      i += isArray ? 2 : 1;
      skipSpaces();
      const path = dottedKey();
      skipSpaces();
      if (isArray) {
        if (peek() !== ']' || peek(1) !== ']') fail(']] 가 없음');
        i += 2;
        const parent = tableAt(data, path.slice(0, -1));
        const last = path[path.length - 1];
        const arr = Object.prototype.hasOwnProperty.call(parent, last) ? parent[last] : undefined;
        const fresh: TomlTable = {};
        if (arr === undefined) setKey(parent, last, [fresh]);
        else if (Array.isArray(arr)) arr.push(fresh);
        else fail(`배열이 아닌 키: ${last}`);
        current = fresh;
      } else {
        if (peek() !== ']') fail('] 가 없음');
        i++;
        current = tableAt(data, path);
      }
      tableLines.set(path.join('.'), startLine);
      endOfLine();
      continue;
    }
    const key = dottedKey();
    skipSpaces();
    if (peek() !== '=') fail('= 가 없음');
    i++;
    skipSpaces();
    assign(current, key, value(0));
    endOfLine();
  }
  return { data, tableLines };
}
