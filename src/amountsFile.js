'use strict';
// Reads a rep amounts spreadsheet (.xlsx or .csv): one row per rep with the rep's name, the payout
// amount and, optionally, a note. A header row ("Rep", "Amount", "Note") is recognised; without one,
// the first three columns are used in that order.
const path = require('path');
const readXlsxFile = require('read-excel-file/node');

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

// Returns { names, amounts, notes } as parallel arrays of strings, or throws an Error with a message
// that is safe to show the user.
async function parseAmountsFile(file) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  let grid;
  try {
    grid = ext === '.csv' ? parseCsv(file.buffer.toString('utf8')) : await readXlsxFile(file.buffer);
  } catch (e) {
    throw new Error('That file could not be read. Upload an .xlsx or .csv file.');
  }
  const cellText = (v) => (v == null ? '' : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).trim());
  const rows = grid.map((r) => r.map(cellText)).filter((r) => r.some((c) => c !== ''));
  if (!rows.length) throw new Error('The file is empty.');

  let nameCol = 0;
  let amountCol = 1;
  let noteCol = 2;
  const head = rows[0].map((c) => c.toLowerCase());
  const findCol = (re) => head.findIndex((h) => re.test(h));
  const hn = findCol(/^(rep|rep name|name|employee)$/);
  const ha = findCol(/amount|payout|total/);
  if (hn !== -1 && ha !== -1) {
    nameCol = hn;
    amountCol = ha;
    const nc = findCol(/note|comment/);
    noteCol = nc === -1 ? -1 : nc;
    rows.shift();
  }
  const names = [];
  const amounts = [];
  const notes = [];
  for (const r of rows) {
    names.push(r[nameCol] || '');
    amounts.push((r[amountCol] || '').replace(/[$,\s]/g, ''));
    notes.push(noteCol >= 0 ? r[noteCol] || '' : '');
  }
  if (!names.length) throw new Error('The file has a header row but no reps.');
  return { names, amounts, notes };
}

module.exports = { parseAmountsFile };
