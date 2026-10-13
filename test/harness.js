// Runs Code.gs in Node against a real Metabase, with in-memory stand-ins for
// the Google Apps Script services it uses. Usage:
//   node test/harness.js <metabaseUrl> <apiKey> <cardId...>
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const [baseUrl, apiKey, ...cardIds] = process.argv.slice(2);
if (!baseUrl || !apiKey || cardIds.length === 0) {
  console.error('usage: node test/harness.js <metabaseUrl> <apiKey> <cardId...>');
  process.exit(2);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function fetch(url, opts = {}) {
  const args = ['-s', '-w', '\n%{http_code}', '-X', (opts.method || 'get').toUpperCase()];
  for (const [k, v] of Object.entries(opts.headers || {})) args.push('-H', `${k}: ${v}`);
  for (const [k, v] of Object.entries(opts.payload || {})) args.push('--data-urlencode', `${k}=${v}`);
  args.push(url);
  const out = execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const cut = out.lastIndexOf('\n');
  const body = out.slice(0, cut);
  const code = Number(out.slice(cut + 1));
  return { getResponseCode: () => code, getContentText: () => body };
}

class FakeSheet {
  constructor(name) { this.name = name; this.grid = []; this.maxRows = 1000; this.maxCols = 26; }
  getName() { return this.name; }
  getMaxRows() { return this.maxRows; }
  getMaxColumns() { return this.maxCols; }
  insertRowsAfter(_, n) { this.maxRows += n; }
  insertColumnsAfter(_, n) { this.maxCols += n; }
  getLastRow() {
    for (let r = this.grid.length - 1; r >= 0; r--) {
      if ((this.grid[r] || []).some((v) => v !== '' && v !== undefined)) return r + 1;
    }
    return 0;
  }
  appendRow(values) { this.grid[this.getLastRow()] = values.slice(); }
  clearContents() { this.grid = []; }
  setFrozenRows() {}
  setColumnWidth() {}
  getRange(row, col, h = 1, w = 1) {
    if (row + h - 1 > this.maxRows || col + w - 1 > this.maxCols) {
      throw new Error(`Range out of bounds on ${this.name}: ${row},${col},${h},${w}`);
    }
    const sheet = this;
    return {
      setValues(values) {
        if (values.length !== h || values.some((r) => r.length !== w)) throw new Error('setValues shape mismatch');
        values.forEach((r, i) => r.forEach((v, j) => {
          sheet.grid[row - 1 + i] = sheet.grid[row - 1 + i] || [];
          sheet.grid[row - 1 + i][col - 1 + j] = v;
        }));
        return this;
      },
      getValues() {
        return Array.from({ length: h }, (_, i) =>
          Array.from({ length: w }, (_, j) => ((sheet.grid[row - 1 + i] || [])[col - 1 + j] ?? '')));
      },
      clearContent() {
        for (let i = 0; i < h; i++) for (let j = 0; j < w; j++) {
          if (sheet.grid[row - 1 + i]) sheet.grid[row - 1 + i][col - 1 + j] = '';
        }
        return this;
      },
      setFontWeight() { return this; },
      setNumberFormat() { return this; },
    };
  }
}

const sheets = new Map();
const spreadsheet = {
  getSheetByName: (n) => sheets.get(n) || null,
  insertSheet: (n) => { const s = new FakeSheet(n); sheets.set(n, s); return s; },
  toast: (msg) => console.log('[toast]', msg),
  getSpreadsheetTimeZone: () => 'America/Los_Angeles',
};
const userProps = new Map();

const context = vm.createContext({
  console,
  Date,
  UrlFetchApp: { fetch },
  Utilities: { parseCsv },
  SpreadsheetApp: { getActive: () => spreadsheet },
  PropertiesService: {
    getUserProperties: () => ({
      getProperty: (k) => userProps.get(k) ?? null,
      setProperties: (o) => Object.entries(o).forEach(([k, v]) => userProps.set(k, v)),
    }),
  },
  LockService: { getDocumentLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
});
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8'), context);

const check = fetch(baseUrl + '/api/user/current', { headers: { 'X-API-Key': apiKey } });
console.log('connection check HTTP', check.getResponseCode());

userProps.set('METABASE_URL', vm.runInContext(`normalizeBaseUrl_(${JSON.stringify(baseUrl + '/question/1')})`, context));
userProps.set('METABASE_API_KEY', apiKey);

const config = vm.runInContext('getConfigSheet_()', context);
cardIds.forEach((id) => config.appendRow([`${baseUrl}/question/${id}-some-slug`, `Card ${id}`, '', '', '']));
config.appendRow(['not a link', 'Bad', '', '', '']);

const result = vm.runInContext('refreshAll()', context);
console.log('refreshAll ->', JSON.stringify(result));
console.log('\nSheetRefresh tab:');
config.getRange(1, 1, config.getLastRow(), 5).getValues().forEach((r) =>
  console.log('  ', r.map((v) => (v instanceof Date ? '<date>' : v)).join(' | ')));
for (const [name, sheet] of sheets) {
  if (name === 'SheetRefresh') continue;
  const rows = sheet.getLastRow();
  console.log(`\n${name}: ${rows} rows, first 4:`);
  sheet.grid.slice(0, 4).forEach((r) => console.log('  ', JSON.stringify(r)));
}

if (cardIds.length > 1) {
  const shrinkTab = `Card ${cardIds[1]}`;
  config.getRange(3, 1, 1, 1).setValues([[`${baseUrl}/question/${cardIds[0]}`]]);
  vm.runInContext('refreshAll()', context);
  const expected = sheets.get(`Card ${cardIds[0]}`).getLastRow();
  const actual = sheets.get(shrinkTab).getLastRow();
  console.log(`\nshrink check: "${shrinkTab}" now has ${actual} rows (expected ${expected}) ->`, actual === expected ? 'PASS' : 'FAIL');
}
