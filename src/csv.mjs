function* records(source, delimiter) {
  let line = 1;
  let startLine = 1;
  let fields = [];
  let value = '';
  let state = 'field';

  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    const newline = char === '\n' || char === '\r';
    if (state === 'quoted') {
      if (char === '"' && source[i + 1] === '"') {
        value += '"';
        i++;
      } else if (char === '"') {
        state = 'closed';
      } else if (newline) {
        if (char === '\r' && source[i + 1] === '\n') i++;
        value += '\n';
        line++;
      } else {
        value += char;
      }
    } else if (char === delimiter || newline) {
      fields.push(value);
      value = '';
      state = 'field';
      if (newline) {
        yield { line: startLine, fields };
        if (char === '\r' && source[i + 1] === '\n') i++;
        fields = [];
        startLine = ++line;
      }
    } else if (char === '"' && state === 'field' && !value) {
      state = 'quoted';
    } else if (char === '"' || state === 'closed') {
      throw new Error(`CSV line ${line}: unexpected character in quoted field`);
    } else {
      value += char;
    }
  }
  if (state === 'quoted') throw new Error(`CSV line ${startLine}: unclosed quoted field`);
  if (fields.length || value || state === 'closed') yield { line: startLine, fields: [...fields, value] };
}

const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function readNumber(value, line, column, factor = 1) {
  const clean = value.trim();
  const result = Number(clean) * factor;
  if (!decimal.test(clean) || !Number.isFinite(result)) {
    throw new Error(`CSV line ${line}: "${column}" must contain a finite decimal number`);
  }
  return result;
}

export function readCapture(source, config) {
  const { timeColumn, timeFactor, delimiter, skipRows, skipDataRows } = config.csv;
  const rows = records(source.replace(/^\uFEFF/, ''), delimiter);
  for (let i = 0; i < skipRows && !rows.next().done; i++) {
    // Skip instrument metadata before the header.
  }
  let header = rows.next().value;
  while (header && header.fields.length === 1 && !header.fields[0].trim()) header = rows.next().value;
  if (!header) throw new Error('CSV header is missing');

  const columns = header.fields.map(value => value.trim());
  const findColumn = name => {
    const index = columns.indexOf(name);
    if (index < 0) throw new Error(`CSV header: missing column "${name}"`);
    if (columns.lastIndexOf(name) !== index) throw new Error(`CSV header: duplicate column "${name}"`);
    return index;
  };
  const timeIndex = findColumn(timeColumn);
  const signalColumns = config.signals.map(signal => findColumn(signal.column));
  const timeMs = [];
  const voltages = config.signals.map(() => []);
  let skip = skipDataRows;

  for (const { line, fields } of rows) {
    if (skip > 0) {
      skip--;
      continue;
    }
    if (fields.length === 1 && !fields[0].trim()) continue;
    if (fields.length !== columns.length) {
      throw new Error(`CSV line ${line}: expected ${columns.length} fields, found ${fields.length}`);
    }
    const time = readNumber(fields[timeIndex], line, timeColumn, timeFactor);
    if (timeMs.length && time <= timeMs.at(-1)) throw new Error(`CSV line ${line}: time must increase strictly`);
    timeMs.push(time);
    signalColumns.forEach((column, index) => {
      voltages[index].push(readNumber(fields[column], line, columns[column]));
    });
  }

  if (timeMs.length < 2) throw new Error('CSV must contain at least two samples');
  if (!Number.isFinite(timeMs.at(-1) - timeMs[0])) throw new Error('CSV time span is too large');
  return { timeMs, voltages };
}
