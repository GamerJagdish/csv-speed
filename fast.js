// csv-speed's byte transducer: reads /input/cases.json as raw bytes and writes /output/answers.json as raw bytes,
// never decoding a case's CSV text into JavaScript strings. In the JSON-escaped text the only bytes that matter to a
// CSV reader are a comma (0x2C), a backslash (0x5C, which starts an escape: \" is a quote, \n a line feed, \r a carriage
// return) and the raw quote (0x22) that ends the JSON string. Field content is copied across byte for byte, since it is
// already valid JSON string content, and only the structure (["...","..."], errors) is written around it.
// A case whose text holds an escape this reader does not expect is answered by solve.js's run() instead.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const IN = path.join(process.env.MAKEFUN_INPUT_DIR || '/input', 'cases.json');
const OUT = path.join(process.env.MAKEFUN_OUTPUT_DIR || '/output', 'answers.json');

const QUOTE = 0x22;
const COMMA = 0x2c;
const BSLASH = 0x5c;
const LOWER_N = 0x6e;
const LOWER_R = 0x72;
const LOWER_U = 0x75;

const bytes = (s) => Buffer.from(s, 'latin1');
const T_COLUMNS = bytes('{"columns":');
const T_NULL_ROWS = bytes('null,"rows":[');
const T_ROWS = bytes(',"rows":[');
const T_EMPTY_ROWS = bytes('[],"rows":[');
const T_ERRORS = bytes('],"errors":[');
const T_END = bytes(']}');
const T_PAD = bytes(',""');
const E_STRAY = bytes('{"code":"stray_cr","line":');
const E_JUNK = bytes('{"code":"quote_junk","line":');
const E_UNTERM = bytes('{"code":"unterminated_quote","line":');
const E_SHORT = bytes('{"code":"short_row","line":');
const E_LONG = bytes('{"code":"long_row","line":');
const E_ROW = bytes(',"row":');
const E_NULL = bytes('null');
const E_FIELDS = bytes(',"fields":');
const E_EXTRA = bytes(',"extra":[');
const K_TEXT = bytes('"text":"');
const K_HEADER = bytes('"header":');

let O = null; // the output bytes
let E = Buffer.allocUnsafe(1 << 22); // one case's errors, as JSON objects separated by commas (pages untouched until used)
let eLen = 0;
let odd = false; // a case whose text escapes a CSV special character as \u00XY is answered by solve.js

function growE(need) {
  if (eLen + need <= E.length) return;
  let size = E.length * 2;
  while (size < eLen + need) size *= 2;
  const next = Buffer.allocUnsafe(size);
  E.copy(next, 0, 0, eLen);
  E = next;
}

function putE(t) {
  growE(t.length);
  t.copy(E, eLen);
  eLen += t.length;
}

function numE(n) {
  growE(12);
  if (n < 0) {
    E_NULL.copy(E, eLen);
    eLen += 4;
    return;
  }
  if (n === 0) {
    E[eLen++] = 0x30;
    return;
  }
  let digits = 0;
  for (let m = n; m > 0; m = (m / 10) | 0) digits += 1;
  let at = eLen + digits;
  eLen = at;
  for (let m = n; m > 0; m = (m / 10) | 0) E[--at] = 0x30 + (m % 10);
}

/** Starts an error object: `{"code":...,"line":L,"row":R` (row -1 is the header's null). */
function errStart(code, line, row) {
  if (eLen > 0) {
    growE(1);
    E[eLen++] = COMMA;
  }
  putE(code);
  numE(line);
  putE(E_ROW);
  numE(row);
}

function errSimple(code, line, row) {
  errStart(code, line, row);
  growE(1);
  E[eLen++] = 0x7d;
}

function growO(o, need) {
  if (o + need <= O.length) return;
  const next = Buffer.allocUnsafe(Math.max(O.length * 2, o + need + (1 << 20)));
  O.copy(next, 0, 0, o);
  O = next;
}

function put(o, t) {
  t.copy(O, o);
  return o + t.length;
}

// Byte classes for the two copy loops: 1 marks a byte that ends a plain run. Outside quotes that is a comma, a
// backslash (an escape) or a raw quote (the end of the text); inside quotes a comma is ordinary.
const STOP_PLAIN = new Uint8Array(256);
STOP_PLAIN[COMMA] = 1;
STOP_PLAIN[BSLASH] = 1;
STOP_PLAIN[QUOTE] = 1;
const STOP_QUOTED = new Uint8Array(256);
STOP_QUOTED[BSLASH] = 1;
STOP_QUOTED[QUOTE] = 1;

/** Copies the ordinary bytes I[p..] to out[o..] up to the first comma, backslash or quote; returns where it stopped. */
function copyPlain(I, out, p, o) {
  for (;;) {
    const c = I[p];
    if (STOP_PLAIN[c] !== 0) return p;
    out[o] = c;
    o += 1;
    p += 1;
  }
}

/** The same inside a quoted field, where only a backslash or a raw quote stops it. */
function copyQuoted(I, out, p, o) {
  for (;;) {
    const c = I[p];
    if (STOP_QUOTED[c] !== 0) return p;
    out[o] = c;
    o += 1;
    p += 1;
  }
}

/**
 * One case: its JSON-escaped text is I[s, e) (e is the raw quote that closes it). Writes the answer at O[o] and
 * returns the end. Mirrors csv-reader 1.0.0's readCsv token for token, on escaped bytes. Ordinary bytes and commas
 * stay in one tight loop: a comma closes the field and opens the next in place (`","`), so a row of plain fields
 * never leaves it; only escapes, quotes and line ends take the slower paths.
 */
function transduce(I, s, e, header, o) {
  eLen = 0;
  odd = false;
  let p = s;
  if (I[p] === 0xef && I[p + 1] === 0xbb && I[p + 2] === 0xbf) p += 3; // a U+FEFF at the very start is dropped
  else if (I[p] === BSLASH && I[p + 1] === LOWER_U && (I[p + 2] | 0x20) === 0x66 && (I[p + 3] | 0x20) === 0x65) odd = true; // an escaped one
  let line = 1;
  let width = -1;
  let rows = 0;
  let haveColumns = !header;
  growO(o, 3 * (e - p) + 256);
  let out = O; // the output, held locally so the hot loops do not reload it (read again after growO)
  o = put(o, T_COLUMNS);
  if (!header) o = put(o, T_NULL_ROWS);

  for (;;) {
    // Lines with no characters (LF or CRLF alone) are no records.
    while (I[p] === BSLASH) {
      const d = I[p + 1];
      if (d === LOWER_N) {
        p += 2;
        line += 1;
      } else if (d === LOWER_R && I[p + 2] === BSLASH && I[p + 3] === LOWER_N) {
        p += 4;
        line += 1;
      } else break;
    }
    if (I[p] === QUOTE) break; // the end of the text

    const recLine = line;
    const headerRec = !haveColumns;
    const recRow = headerRec ? -1 : rows;
    const recStart = o;
    if (!headerRec && rows > 0) out[o++] = COMMA;
    out[o] = 0x5b;
    out[o + 1] = QUOTE;
    o += 2;
    let nf = 1; // fields begun in this record
    let cut = -1; // where a long row's extra fields begin (the comma before field `width`)
    let fieldStart = o;
    let lastQuoted = false;
    let junkFrom = -1;

    field: for (;;) {
      // At the start of a field. A field that opens with a quote runs to the next quote that is not doubled.
      junkFrom = -1;
      lastQuoted = I[p] === BSLASH && I[p + 1] === QUOTE;
      if (lastQuoted) {
        const open = p;
        const openLine = line;
        p += 2;
        let closed = false;
        for (;;) {
          const q = copyQuoted(I, out, p, o);
          o += q - p;
          p = q;
          const c = I[p];
          if (c === QUOTE) break; // the text ended first
          const d = I[p + 1];
          if (d === QUOTE) {
            if (I[p + 2] === BSLASH && I[p + 3] === QUOTE) {
              out[o] = BSLASH;
              out[o + 1] = QUOTE;
              o += 2;
              p += 4;
              continue;
            }
            p += 2;
            closed = true;
            break;
          }
          if (d === LOWER_R) {
            // CRLF and a lone CR inside quotes are each one LF.
            out[o] = BSLASH;
            out[o + 1] = LOWER_N;
            o += 2;
            line += 1;
            p += I[p + 2] === BSLASH && I[p + 3] === LOWER_N ? 4 : 2;
            continue;
          }
          if (d === LOWER_N) {
            out[o] = BSLASH;
            out[o + 1] = LOWER_N;
            o += 2;
            line += 1;
            p += 2;
            continue;
          }
          if (d === LOWER_U) {
            if (I[p + 2] === 0x30 && I[p + 3] === 0x30 && oddU(I[p + 4], I[p + 5])) odd = true;
            out[o] = c;
            out[o + 1] = d;
            out[o + 2] = I[p + 2];
            out[o + 3] = I[p + 3];
            out[o + 4] = I[p + 4];
            out[o + 5] = I[p + 5];
            o += 6;
            p += 6;
            continue;
          }
          out[o] = c;
          out[o + 1] = d;
          o += 2;
          p += 2;
        }
        if (!closed) {
          // The quote never closes: it is a literal character, and the text after it is read again as unquoted.
          o = fieldStart;
          p = open + 2;
          line = openLine;
          errSimple(E_UNTERM, recLine, recRow);
          out[o] = BSLASH;
          out[o + 1] = QUOTE;
          o += 2;
        } else {
          const c = I[p];
          if (c === QUOTE) break field; // the end of the text
          if (c === COMMA) {
            p += 1;
            out[o] = QUOTE;
            out[o + 1] = COMMA;
            out[o + 2] = QUOTE;
            if (nf === width && cut < 0) cut = o + 1;
            o += 3;
            nf += 1;
            fieldStart = o;
            continue field;
          }
          if (c === BSLASH && I[p + 1] === LOWER_N) {
            p += 2;
            line += 1;
            break field;
          }
          if (c === BSLASH && I[p + 1] === LOWER_R && I[p + 2] === BSLASH && I[p + 3] === LOWER_N) {
            p += 4;
            line += 1;
            break field;
          }
          junkFrom = o; // what follows the closing quote is appended as it stands
        }
      }

      // Unquoted bytes up to a line end or the end of the text; commas close and open fields in place.
      for (;;) {
        const q = copyPlain(I, out, p, o);
        o += q - p;
        p = q;
        const c = I[p];
        if (c === COMMA) {
          p += 1;
          if (junkFrom >= 0) {
            if (o > junkFrom) errSimple(E_JUNK, recLine, recRow);
            junkFrom = -1;
          }
          out[o] = QUOTE;
          out[o + 1] = COMMA;
          out[o + 2] = QUOTE;
          if (nf === width && cut < 0) cut = o + 1;
          o += 3;
          nf += 1;
          fieldStart = o;
          if (I[p] === BSLASH && I[p + 1] === QUOTE) continue field;
          lastQuoted = false;
          continue;
        }
        if (c === QUOTE) break field; // the end of the text
        const d = I[p + 1];
        if (d === LOWER_N) {
          p += 2;
          line += 1;
          break field;
        }
        if (d === LOWER_R) {
          if (I[p + 2] === BSLASH && I[p + 3] === LOWER_N) {
            p += 4;
            line += 1;
            break field;
          }
          errSimple(E_STRAY, recLine, recRow); // a CR not followed by LF is dropped
          p += 2;
          continue;
        }
        if (d === LOWER_U) {
          if (I[p + 2] === 0x30 && I[p + 3] === 0x30 && oddU(I[p + 4], I[p + 5])) odd = true;
          out[o] = c;
          out[o + 1] = d;
          out[o + 2] = I[p + 2];
          out[o + 3] = I[p + 3];
          out[o + 4] = I[p + 4];
          out[o + 5] = I[p + 5];
          o += 6;
          p += 6;
          continue;
        }
        out[o] = c;
        out[o + 1] = d;
        o += 2;
        p += 2;
      }
    }

    // The record has ended: close its last field.
    if (junkFrom >= 0 && o > junkFrom) errSimple(E_JUNK, recLine, recRow);
    out[o++] = QUOTE;
    // A line of nothing but stray CRs leaves one empty unquoted field: no record (its stray_cr errors stay).
    if (nf === 1 && !lastQuoted && o === fieldStart + 1) {
      o = recStart;
      continue;
    }
    if (width < 0) width = nf;
    if (headerRec) {
      out[o++] = 0x5d;
      o = put(o, T_ROWS);
      haveColumns = true;
      continue;
    }
    if (nf < width) {
      errStart(E_SHORT, recLine, recRow);
      putE(E_FIELDS);
      numE(nf);
      growE(1);
      E[eLen++] = 0x7d;
      growO(o, 3 * (width - nf) + 3 * (e - p) + 256);
      out = O;
      for (let k = nf; k < width; k += 1) {
        out[o] = COMMA;
        out[o + 1] = QUOTE;
        out[o + 2] = QUOTE;
        o += 3;
      }
    } else if (nf > width) {
      errStart(E_LONG, recLine, recRow);
      putE(E_EXTRA);
      const n = o - (cut + 1);
      growE(n + 2);
      out.copy(E, eLen, cut + 1, o);
      eLen += n;
      E[eLen++] = 0x5d;
      E[eLen++] = 0x7d;
      o = cut;
    }
    out[o++] = 0x5d;
    rows += 1;
  }

  if (!haveColumns) {
    growO(o, T_EMPTY_ROWS.length);
    o = put(o, T_EMPTY_ROWS);
  }
  growO(o, eLen + 32);
  o = put(o, T_ERRORS);
  E.copy(O, o, 0, eLen);
  o += eLen;
  return put(o, T_END);
}

/** True when a \u00 escape ending in hex digits x, y (bytes) is a line feed, carriage return, quote or comma. */
function oddU(x, y) {
  const lo = y | 0x20;
  if (x === 0x30) return lo === 0x61 || lo === 0x64; // 0a, 0d
  if (x === 0x32) return y === 0x32 || lo === 0x63; // 22, 2c
  return false;
}

/** The exact answer by csv-reader's own rules, for a case the transducer passes over. */
function viaSolve(I, s, e, header, o) {
  const { run } = require('./solve.js');
  const text = JSON.parse(I.toString('utf8', s - 1, e + 1));
  const answer = Buffer.from(JSON.stringify(run({ text, header })), 'utf8');
  growO(o, answer.length);
  answer.copy(O, o);
  return o + answer.length;
}

// Warm-up: a few tiny texts that take every branch (BOM, CRLF and lone CR in and out of quotes, doubled quotes,
// quote junk, \u escapes, empty and stray-CR lines, short and long rows, an unterminated quote) so V8 has type
// feedback for all of transduce before the real input, and optimizes it once instead of deoptimizing on each new path.
const WARM = [
  ['h1,h2,h3\r\nx,"q""y",z\r\n\r\n"multi\r\nline\rcr",b,\u0001\n"j"unk,"j"\r,c\nshort\nlong,1,2,3,4\n\r\r\n\\, ,é\n"never closed,x\r\nrest', true],
  ['﻿a,b\r\n,\n"x"\r\n""\n1,2,3\nlast,"open', false],
  ['"a\nb","\u0001\\\t","x\b"\np"q,"r"\r\n"s"t\n"end"', false],
  ['\r\r\n\r', true],
  ['k,v\n"a"b', true],
  ['a\n\nb\r\n\n\nc,\u0007', false],
  ['a,b\n"x","y","z"\n"p",q,"r"\r\nu,"v"w,"x"', false],
];
// Then short pseudo-random texts from the same pieces, so every combination of paths (a quoted field at a long
// row's cut, junk before a stray CR, ...) has run before V8 optimizes. A fixed seed keeps every run identical.
const PIECES = ['a', 'bc', ',', ',', ',', '"', '"', '""', '\n', '\r', '\r\n', '\r\n', ' ', 'é', '\u0001', '\\', '"x', 'x"', '"a,b"', '"q""q"', ',,'];
let seed = 1234567;
for (let i = 0; i < 300; i += 1) {
  let text = '';
  const len = 4 + (i % 24);
  for (let j = 0; j < len; j += 1) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    text += PIECES[seed % PIECES.length];
  }
  WARM.push([text, (i & 1) === 0]);
}
O = Buffer.allocUnsafe(1 << 16);
const warmUp = () => {
  for (const [text, header] of WARM) {
    const W = Buffer.from(JSON.stringify(text), 'utf8');
    transduce(W, 1, W.length - 1, header, 0);
  }
};
for (let round = 0; round < 4; round += 1) warmUp();
// Left to itself V8 runs the real input in its mid tier (Maglev) and finishes TurboFan only afterwards. So ask for
// TurboFan now, on this thread, from the warm-up's feedback: the rules let an entry tune V8's flags. If the natives
// syntax is refused, nothing changes but the speed.
try {
  require('node:v8').setFlagsFromString('--allow-natives-syntax');
  new Function(
    't',
    'a',
    'b',
    '%PrepareFunctionForOptimization(a); %OptimizeFunctionOnNextCall(a);' +
      '%PrepareFunctionForOptimization(b); %OptimizeFunctionOnNextCall(b);' +
      '%PrepareFunctionForOptimization(t); %OptimizeMaglevOnNextCall(t);',
  )(transduce, copyPlain, copyQuoted);
  warmUp();
} catch {
  // keep the default tiering
}

const I = fs.readFileSync(IN);
O = Buffer.allocUnsafe(3 * I.length + (1 << 16));
let o = 0;
O[o++] = 0x5b;
let at = 0;
let first = true;
for (;;) {
  const k = I.indexOf(K_TEXT, at);
  if (k < 0) break;
  const s = k + K_TEXT.length;
  const objStart = I.lastIndexOf(0x7b, k);
  const hk = I.indexOf(K_HEADER, objStart);
  let e;
  if (hk > s && I[hk - 1] === COMMA && I[hk - 2] === QUOTE) e = hk - 2;
  else {
    // The text's end found the slow way: the first quote not escaped by an odd run of backslashes.
    e = s;
    for (;;) {
      e = I.indexOf(QUOTE, e);
      let b = 0;
      while (I[e - 1 - b] === BSLASH) b += 1;
      if ((b & 1) === 0) break;
      e += 1;
    }
  }
  const header = hk >= 0 && I[hk + K_HEADER.length] === 0x74;
  if (!first) O[o++] = COMMA;
  first = false;
  const start = o;
  o = transduce(I, s, e, header, o);
  if (odd) o = viaSolve(I, s, e, header, start);
  at = e + 1;
}
growO(o, 1);
O[o++] = 0x5d;
fs.writeFileSync(OUT, O.subarray(0, o));
