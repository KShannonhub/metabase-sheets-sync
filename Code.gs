/**
 * SheetRefresh — keep Metabase questions refreshed in Google Sheets.
 * Free and open source (MIT). Not affiliated with Metabase, Inc. or Google LLC.
 *
 * @OnlyCurrentDoc
 */

const CONFIG_SHEET = 'SheetRefresh';
const CONFIG_HEADER = ['Metabase question (link or number)', 'Destination tab', 'Last refresh', 'Rows', 'Status'];
const PROP_URL = 'METABASE_URL';
const PROP_KEY = 'METABASE_API_KEY';
const MAX_CELLS = 10000000;

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('SheetRefresh')
    .addItem('Connect to Metabase', 'connect')
    .addItem('Add a question', 'addQuestion')
    .addSeparator()
    .addItem('Refresh all now', 'refreshAllNow')
    .addSeparator()
    .addItem('Refresh every hour', 'scheduleHourly')
    .addItem('Refresh every morning (around 7 AM)', 'scheduleDaily')
    .addItem('Stop automatic refresh', 'stopSchedule')
    .addToUi();
}

function connect() {
  const ui = SpreadsheetApp.getUi();
  const urlAnswer = ui.prompt(
    'Connect to Metabase (1 of 2)',
    'Your Metabase address, e.g. https://yourcompany.metabaseapp.com',
    ui.ButtonSet.OK_CANCEL
  );
  if (urlAnswer.getSelectedButton() !== ui.Button.OK) return;

  const keyAnswer = ui.prompt(
    'Connect to Metabase (2 of 2)',
    'A Metabase API key (Admin → Settings → Authentication → API Keys).\n' +
      'Give it a group that can only see what this Sheet needs.',
    ui.ButtonSet.OK_CANCEL
  );
  if (keyAnswer.getSelectedButton() !== ui.Button.OK) return;

  let baseUrl;
  try {
    baseUrl = normalizeBaseUrl_(urlAnswer.getResponseText());
  } catch (err) {
    ui.alert(err.message);
    return;
  }
  const apiKey = keyAnswer.getResponseText().trim();
  if (!apiKey) {
    ui.alert('The API key was empty. Nothing was saved.');
    return;
  }

  const check = UrlFetchApp.fetch(baseUrl + '/api/user/current', {
    headers: { 'X-API-Key': apiKey },
    muteHttpExceptions: true,
  });
  if (check.getResponseCode() !== 200) {
    ui.alert(
      'Could not connect',
      describeHttpError_(check.getResponseCode()) +
        '\n\nGoogle must be able to reach your Metabase over the internet ' +
        '(Metabase Cloud, or self-hosted on a public address).',
      ui.ButtonSet.OK
    );
    return;
  }

  PropertiesService.getUserProperties().setProperties({ [PROP_URL]: baseUrl, [PROP_KEY]: apiKey });
  getConfigSheet_();
  ui.alert('Connected to ' + baseUrl + '. Next: SheetRefresh → Add a question.');
}

function addQuestion() {
  const ui = SpreadsheetApp.getUi();
  const questionAnswer = ui.prompt(
    'Add a question (1 of 2)',
    'Paste the link to a saved Metabase question, e.g. https://yourcompany.metabaseapp.com/question/123',
    ui.ButtonSet.OK_CANCEL
  );
  if (questionAnswer.getSelectedButton() !== ui.Button.OK) return;

  let cardId;
  try {
    cardId = parseCardId_(questionAnswer.getResponseText());
  } catch (err) {
    ui.alert(err.message);
    return;
  }

  const tabAnswer = ui.prompt(
    'Add a question (2 of 2)',
    'Name of the tab to fill with results (it will be created if missing).',
    ui.ButtonSet.OK_CANCEL
  );
  if (tabAnswer.getSelectedButton() !== ui.Button.OK) return;

  const tab = tabAnswer.getResponseText().trim() || 'Question ' + cardId;
  if (tab === CONFIG_SHEET) {
    ui.alert('Pick a different tab name — "' + CONFIG_SHEET + '" holds your settings.');
    return;
  }

  getConfigSheet_().appendRow([questionAnswer.getResponseText().trim(), tab, '', '', 'Not refreshed yet']);
  ui.alert('Added. Run SheetRefresh → Refresh all now to fill "' + tab + '".');
}

function refreshAllNow() {
  const result = refreshAll();
  const ss = SpreadsheetApp.getActive();
  if (result.busy) {
    ss.toast('A refresh is already running. Try again in a minute.', 'SheetRefresh');
  } else if (result.ok + result.failed === 0) {
    ss.toast('No questions yet. Use SheetRefresh → Add a question.', 'SheetRefresh');
  } else {
    const failedNote = result.failed ? ' ' + result.failed + ' failed — see the Status column.' : '';
    ss.toast(result.ok + ' refreshed.' + failedNote, 'SheetRefresh');
  }
}

/** Entry point for the time-driven trigger. */
function refreshAll() {
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(30000)) return { ok: 0, failed: 0, busy: true };
  try {
    const connection = getConnection_();
    const sheet = getConfigSheet_();
    const lastRow = sheet.getLastRow();
    let ok = 0;
    let failed = 0;
    if (lastRow < 2) return { ok: ok, failed: failed };

    const rows = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
    rows.forEach(function (row, index) {
      const question = String(row[0]).trim();
      if (!question) return;
      const sheetRow = index + 2;
      try {
        const cardId = parseCardId_(question);
        const tab = String(row[1]).trim() || 'Question ' + cardId;
        if (tab === CONFIG_SHEET) throw new Error('Destination tab cannot be "' + CONFIG_SHEET + '".');
        const result = fetchQuestion_(connection, cardId);
        writeTable_(tab, result.values);
        sheet.getRange(sheetRow, 2, 1, 4).setValues([[tab, new Date(), Math.max(result.values.length - 1, 0), result.note || 'OK']]);
        ok++;
      } catch (err) {
        sheet.getRange(sheetRow, 3, 1, 3).setValues([[new Date(), '', 'Error: ' + err.message]]);
        failed++;
      }
    });
    return { ok: ok, failed: failed };
  } finally {
    lock.releaseLock();
  }
}

function scheduleHourly() {
  setSchedule_(function (builder) {
    return builder.everyHours(1);
  }, 'every hour');
}

function scheduleDaily() {
  const timeZone = SpreadsheetApp.getActive().getSpreadsheetTimeZone();
  setSchedule_(function (builder) {
    return builder.everyDays(1).atHour(7).inTimezone(timeZone);
  }, 'every morning around 7 AM (' + timeZone + ')');
}

function stopSchedule() {
  const removed = deleteRefreshTriggers_();
  SpreadsheetApp.getUi().alert(removed ? 'Automatic refresh is off.' : 'Automatic refresh was already off.');
}

function setSchedule_(configure, label) {
  const ui = SpreadsheetApp.getUi();
  try {
    getConnection_();
  } catch (err) {
    ui.alert(err.message);
    return;
  }
  deleteRefreshTriggers_();
  configure(ScriptApp.newTrigger('refreshAll').timeBased()).create();
  ui.alert('This Sheet will refresh ' + label + '.\nIt keeps running while your browser is closed.');
}

function deleteRefreshTriggers_() {
  let removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'refreshAll') {
      ScriptApp.deleteTrigger(trigger);
      removed++;
    }
  });
  return removed;
}

function getConnection_() {
  const props = PropertiesService.getUserProperties();
  const baseUrl = props.getProperty(PROP_URL);
  const apiKey = props.getProperty(PROP_KEY);
  if (!baseUrl || !apiKey) throw new Error('Not connected yet. Use SheetRefresh → Connect to Metabase.');
  return { baseUrl: baseUrl, apiKey: apiKey };
}

function getConfigSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(CONFIG_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG_SHEET, 0);
    sheet.getRange(1, 1, 1, CONFIG_HEADER.length).setValues([CONFIG_HEADER]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 380);
    sheet.setColumnWidth(2, 180);
    sheet.setColumnWidth(3, 160);
    sheet.setColumnWidth(5, 380);
  }
  return sheet;
}

function fetchQuestion_(connection, cardId) {
  const response = UrlFetchApp.fetch(connection.baseUrl + '/api/card/' + cardId + '/query/csv', {
    method: 'post',
    headers: { 'X-API-Key': connection.apiKey },
    payload: { parameters: '[]', format_rows: 'false' },
    muteHttpExceptions: true,
  });
  const code = response.getResponseCode();
  const text = response.getContentText();
  const queryError = metabaseErrorFromBody_(text);
  if (queryError) throw new Error('Metabase could not run this question: ' + queryError);
  if (code !== 200) throw new Error(describeHttpError_(code));

  const values = Utilities.parseCsv(text).map(function (row) {
    return row.map(cleanCell_);
  });
  return { values: values };
}

/** Metabase reports failed exports as a JSON error body instead of CSV. */
function metabaseErrorFromBody_(text) {
  const trimmed = text.trim();
  if (trimmed.charAt(0) !== '{') return null;
  try {
    const body = JSON.parse(trimmed);
    if (body && (body.status === 'failed' || body.error)) return String(body.error || 'unknown error');
  } catch (err) {
    return null;
  }
  return null;
}

function writeTable_(tabName, values) {
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(tabName);
  const isNew = !sheet;
  if (isNew) sheet = ss.insertSheet(tabName);

  const height = values.length;
  const width = values.reduce(function (max, row) {
    return Math.max(max, row.length);
  }, 0);
  if (height === 0 || width === 0) {
    sheet.clearContents();
    return;
  }
  if (height * width > MAX_CELLS) {
    throw new Error('Result is ' + height * width + ' cells; Google Sheets allows ' + MAX_CELLS + '. Filter the question down.');
  }

  const rows = values.map(function (row) {
    return row.length === width ? row : row.concat(new Array(width - row.length).fill(''));
  });
  if (sheet.getMaxRows() < height) sheet.insertRowsAfter(sheet.getMaxRows(), height - sheet.getMaxRows());
  if (sheet.getMaxColumns() < width) sheet.insertColumnsAfter(sheet.getMaxColumns(), width - sheet.getMaxColumns());

  sheet.getRange(1, 1, height, width).setValues(rows);
  if (sheet.getMaxRows() > height) {
    sheet.getRange(height + 1, 1, sheet.getMaxRows() - height, sheet.getMaxColumns()).clearContent();
  }
  if (sheet.getMaxColumns() > width) {
    sheet.getRange(1, width + 1, height, sheet.getMaxColumns() - width).clearContent();
  }

  if (isNew) {
    sheet.getRange(1, 1, 1, width).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
}

/**
 * Sheets treats written strings like typed input: "=..." becomes a formula,
 * "00123" becomes 123, and long IDs lose precision. Keep Metabase values as data.
 * Metabase's CSV already prefixes formula-like values with an apostrophe.
 */
function cleanCell_(value) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') return value;
  if (/^'[=+\-@]/.test(value)) return value;
  if (/^-?\d+$/.test(value)) {
    const isPaddedOrHuge = /^-?0\d/.test(value) || !Number.isSafeInteger(Number(value));
    return isPaddedOrHuge ? "'" + value : Number(value);
  }
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(value)) return Number(value);
  if (/^[=+\-@']/.test(value)) return "'" + value;
  return value;
}

function parseCardId_(input) {
  const text = String(input).trim();
  if (/^\d+$/.test(text)) return text;
  const match = text.match(/\/(?:question|model|metric)\/(\d+)/);
  if (match) return match[1];
  throw new Error('Use a saved question link like https://yourcompany.metabaseapp.com/question/123, or just the number 123.');
}

function normalizeBaseUrl_(input) {
  let url = String(input).trim().replace(/[?#].*$/, '');
  if (!/^https?:\/\//i.test(url)) throw new Error('The Metabase address must start with https://');
  url = url.replace(/\/(question|model|metric|dashboard|collection|browse|admin|auth)(\/.*)?$/, '');
  return url.replace(/\/+$/, '');
}

function describeHttpError_(code) {
  if (code === 401) return 'Metabase rejected the API key (401). Check the key or create a new one.';
  if (code === 403) return "The API key's group can't see this (403). Give its group access in Metabase.";
  if (code === 404) return 'Not found (404). Check the Metabase address and question number.';
  return 'Metabase returned HTTP ' + code + '.';
}
