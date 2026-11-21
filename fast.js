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

let O = null; // the output bytes: a window of the output file, flushed at record boundaries
let fd = -1; // the output file
const WINDOW = 1 << 18; // flush once a window holds this many bytes
let windowLimit = WINDOW;
let flushedInCase = false;

/** Writes O[0, o) to the output file and returns the window's new start, 0. */
function flushOut(o) {
  fs.writeSync(fd, O, 0, o);
  flushedInCase = true;
  return 0;
}
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
    if (o > windowLimit) o = flushOut(o); // between records, where nothing written can still be taken back
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
// The warm-up writes through the same flush path as the real run (to the output file, which the real run then
// truncates), with a tiny window so every flush branch has feedback too.
O = Buffer.allocUnsafe(1 << 16);
fd = fs.openSync(OUT, 'w');
const warmUp = () => {
  for (let i = 0; i < WARM.length; i += 1) {
    // A handful of texts flush at every record (a few dozen writes in all); the rest never reach the window.
    windowLimit = i < 6 ? 64 : WINDOW;
    const W = Buffer.from(JSON.stringify(WARM[i][0]), 'utf8');
    transduce(W, 1, W.length - 1, WARM[i][1], 0);
  }
};
for (let round = 0; round < 4; round += 1) warmUp();
// Node 22 (V8 12.4, no Maglev) tiers transduce up to TurboFan on a background thread that tends to finish after the
// real input has started, leaving it in baseline code and paying a second, OSR compile. So: compile the copy loops,
// let any background job finish, and compile transduce now, on this thread, from the warm-up's feedback. The rules
// let an entry tune V8's flags. If the natives syntax is refused, nothing changes but the speed.
try {
  require('node:v8').setFlagsFromString('--allow-natives-syntax');
  const T = Buffer.from('a"');
  const U = Buffer.allocUnsafe(8);
  new Function(
    't',
    'a',
    'b',
    'T',
    'U',
    '%PrepareFunctionForOptimization(a); %OptimizeFunctionOnNextCall(a); a(T, U, 0, 0);' +
      '%PrepareFunctionForOptimization(b); %OptimizeFunctionOnNextCall(b); b(T, U, 0, 0);' +
      '%FinalizeOptimization(); %PrepareFunctionForOptimization(t); %OptimizeFunctionOnNextCall(t);',
  )(transduce, copyPlain, copyQuoted, T, U);
  warmUp();
} catch {
  // keep the default tiering
}
fs.closeSync(fd);

// The input is read case by case into one window that is reused (and grown only if a case needs more), so the
// pages touched for input stay about one case's worth instead of the whole file's.
let W = Buffer.allocUnsafe(1 << 22);
let wLen = 0; // bytes of W holding input
let eof = false;
let fdIn = -1;

/** Keeps W[from, wLen) (moved to the start of W) and reads more of the input after it. */
function refill(from) {
  if (from > 0) {
    W.copyWithin(0, from, wLen);
    wLen -= from;
  }
  if (wLen === W.length) {
    const next = Buffer.allocUnsafe(W.length * 2);
    W.copy(next, 0, 0, wLen);
    W = next;
  }
  const n = fs.readSync(fdIn, W, wLen, W.length - wLen, null);
  if (n === 0) eof = true;
  else wLen += n;
}

/**
 * Writes every case's answer. With `stream`, the output is flushed in windows at record boundaries, so only the
 * first window's pages of O are ever touched. Returns false if a case needed solve.js after part of it was already
 * flushed: the caller then writes everything again without streaming.
 */
function writeAll(stream) {
  fdIn = fs.openSync(IN, 'r');
  wLen = 0;
  eof = false;
  refill(0);
  fd = fs.openSync(OUT, 'w');
  windowLimit = stream ? WINDOW : Infinity;
  O = Buffer.allocUnsafe(3 * W.length + (1 << 16));
  let o = 0;
  O[o++] = 0x5b;
  let at = 0;
  let first = true;
  for (;;) {
    const I = W.subarray(0, wLen);
    const k = I.indexOf(K_TEXT, at);
    if (k < 0) {
      if (eof) break;
      refill(at);
      at = 0;
      continue;
    }
    const s = k + K_TEXT.length;
    const objStart = I.lastIndexOf(0x7b, k);
    const hk = I.indexOf(K_HEADER, objStart);
    let e;
    if (hk > s && I[hk - 1] === COMMA && I[hk - 2] === QUOTE && hk + K_HEADER.length < wLen) e = hk - 2;
    else if (!eof) {
      // This case's text does not end inside the window yet: read on, keeping it, and look again.
      refill(at);
      at = 0;
      continue;
    } else {
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
    flushedInCase = false;
    o = transduce(I, s, e, header, o);
    if (odd) {
      if (flushedInCase) {
        fs.closeSync(fd);
        fs.closeSync(fdIn);
        return false;
      }
      o = viaSolve(I, s, e, header, start);
    }
    at = e + 1;
  }
  growO(o, 1);
  O[o++] = 0x5d;
  flushOut(o);
  fs.closeSync(fd);
  fs.closeSync(fdIn);
  return true;
}

if (!writeAll(true)) writeAll(false);
