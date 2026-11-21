// A faster drop-in for csv-reader 1.0.0's readCsv: the same answer {columns, rows, errors} for every input, read in
// one pass over char codes. Fields are cut out with slice() rather than grown a character at a time, quoted fields
// are found with indexOf(), and line breaks inside quotes are counted from cached next-LF / next-CR positions so the
// text is scanned once. A quote that never closes costs one scan to the end, as in csv-reader; after it every later
// run of quotes is even, so every later quoted field closes within its own run and no second such scan happens.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

const QUOTE = 34;
const COMMA_CODE = 44;
const LF = 10;
const CR = 13;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;
  let ended = END;
  let recordLine = 1;
  let recordRow = null;

  // The next LF and the next CR at or after the last place they were looked up from (-1: look again).
  let nextLf = -1;
  let nextCr = -1;
  let nextComma = -1;

  const fail = (code) => {
    errors.push({ code, line: recordLine, row: recordRow });
  };

  /**
   * Reads unquoted text from i onto `value` up to a comma or line break; stray CRs are dropped (stray_cr). The field's
   * end is the nearest of the cached next comma, next LF and next CR, each found with indexOf and kept until passed.
   */
  const readUnquoted = (value, i) => {
    for (;;) {
      if (nextComma < i) nextComma = indexOrEnd(COMMA_CHAR, i);
      if (nextLf < i) nextLf = indexOrEnd(LF_CHAR, i);
      if (nextCr < i) nextCr = indexOrEnd(CR_CHAR, i);
      const end = nextComma < nextLf ? nextComma : nextLf;
      if (nextCr < end) {
        const cr = nextCr;
        if (text.charCodeAt(cr + 1) === LF) {
          pos = cr + 2;
          line += 1;
          ended = LINE_BREAK;
          return cr === i ? value : value + text.slice(i, cr);
        }
        fail('stray_cr');
        if (cr !== i) value += text.slice(i, cr);
        i = cr + 1;
        continue;
      }
      if (end === n) {
        pos = n;
        ended = END;
      } else if (end === nextComma) {
        pos = end + 1;
        ended = COMMA;
      } else {
        pos = end + 1;
        line += 1;
        ended = LINE_BREAK;
      }
      return end === i ? value : value + text.slice(i, end);
    }
  };

  /** Counts the line breaks of a quoted field's raw text [from, to): each LF, and each CR not followed by LF. */
  const countBreaks = (from, to) => {
    let breaks = 0;
    if (nextLf < from) nextLf = indexOrEnd(LF_CHAR, from);
    while (nextLf < to) {
      breaks += 1;
      nextLf = indexOrEnd(LF_CHAR, nextLf + 1);
    }
    let sawCr = false;
    if (nextCr < from) nextCr = indexOrEnd(CR_CHAR, from);
    while (nextCr < to) {
      sawCr = true;
      if (text.charCodeAt(nextCr + 1) !== LF) breaks += 1;
      nextCr = indexOrEnd(CR_CHAR, nextCr + 1);
    }
    return sawCr ? -1 - breaks : breaks;
  };

  const indexOrEnd = (ch, from) => {
    const i = text.indexOf(ch, from);
    return i < 0 ? n : i;
  };

  /** The unquoted reading of a field whose opening quote at `open` never closes (unterminated_quote). */
  const unterminated = (open, openLine) => {
    pos = open + 1;
    line = openLine;
    nextLf = -1;
    nextCr = -1;
    nextComma = -1;
    fail('unterminated_quote');
    return readUnquoted('"', open + 1);
  };

  /** Reads a quoted field whose opening quote is at pos. */
  const readQuoted = () => {
    const open = pos;
    const openLine = line;
    let value = '';
    let segment = open + 1;
    let i = segment;
    let close;
    for (;;) {
      const q = text.indexOf('"', i);
      if (q < 0) return unterminated(open, openLine);
      if (text.charCodeAt(q + 1) === QUOTE) {
        value += text.slice(segment, q + 1);
        i = q + 2;
        segment = i;
        continue;
      }
      close = q;
      break;
    }
    value = segment === open + 1 ? text.slice(segment, close) : value + text.slice(segment, close);
    const breaks = countBreaks(open + 1, close);
    if (breaks < 0) {
      line += -1 - breaks;
      value = value.replace(CR_RUN, '\n');
    } else {
      line += breaks;
    }
    pos = close + 1;
    if (pos >= n) {
      ended = END;
      return value;
    }
    const c = text.charCodeAt(pos);
    if (c === COMMA_CODE) {
      pos += 1;
      ended = COMMA;
      return value;
    }
    if (c === LF) {
      pos += 1;
      line += 1;
      ended = LINE_BREAK;
      return value;
    }
    if (c === CR && text.charCodeAt(pos + 1) === LF) {
      pos += 2;
      line += 1;
      ended = LINE_BREAK;
      return value;
    }
    // What follows the closing quote is appended as it stands (quote_junk when anything was kept).
    const before = value.length;
    value = readUnquoted(value, pos);
    if (value.length > before) fail('quote_junk');
    return value;
  };

  for (;;) {
    // Lines with no characters (LF or CRLF alone) are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === LF) {
        pos += 1;
        line += 1;
      } else if (c === CR && text.charCodeAt(pos + 1) === LF) {
        pos += 2;
        line += 1;
      } else break;
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted;
    do {
      quoted = text.charCodeAt(pos) === QUOTE;
      fields.push(quoted ? readQuoted() : readUnquoted('', pos));
    } while (ended === COMMA);

    // A line of nothing but stray CRs leaves one empty unquoted field: no record (its stray_cr errors stay).
    if (fields.length === 1 && !quoted && fields[0] === '') continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}

const COMMA_CHAR = ',';
const LF_CHAR = '\n';
const CR_CHAR = '\r';
const CR_RUN = /\r\n?/g;
