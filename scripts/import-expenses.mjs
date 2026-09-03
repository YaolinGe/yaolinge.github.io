#!/usr/bin/env node
/**
 * Load yao.csv and vollum.csv from the money repo into the database, once.
 *
 *   node scripts/import-expenses.mjs ~/money/yao.csv:y ~/money/vollum.csv:v --dry-run
 *   STORAGE_CONNECTION_STRING="..." node scripts/import-expenses.mjs ~/money/yao.csv:y ~/money/vollum.csv:v
 *
 * Each argument is a file path and the payer it belongs to. Rows that already
 * exist (same date, category, type, payer, amount and description) are skipped,
 * so running it twice does not double anybody's rent.
 *
 * That skipping also drops rows the CSVs themselves contain twice. In the files
 * as they stand that is one row - "felleskostnader july", 2358.00 kr, in
 * yao.csv twice - and dropping it moves the balance by that amount. Pass
 * --keep-duplicates to import the files verbatim instead and decide later in
 * the admin. The summary at the end says which rows were dropped.
 */

import { readFile } from "node:fs/promises";

import { createStore } from "../api/src/lib/tables.js";
import { fingerprint, parseExpense } from "../api/src/lib/money.js";

const dryRun = process.argv.includes("--dry-run");
const keepDuplicates = process.argv.includes("--keep-duplicates");
const inputs = process.argv.slice(2).filter((argument) => argument.includes(":"));
if (!inputs.length) {
  console.error("usage: import-expenses.mjs <path>:<payer> [<path>:<payer>] [--dry-run]");
  process.exit(2);
}

/** The old files are simple: no quoted commas outside the description. */
function parseCsvLine(line) {
  const fields = [];
  let current = "";
  let quoted = false;
  for (const character of line) {
    if (character === '"') quoted = !quoted;
    else if (character === "," && !quoted) {
      fields.push(current.trim());
      current = "";
    } else current += character;
  }
  fields.push(current.trim());
  return fields;
}

const store = dryRun ? null : createStore();
const existing = dryRun ? [] : await store.expenses.list();
const seen = new Set(existing.map(fingerprint));
let added = 0;
const dropped = [];
const failed = [];

for (const input of inputs) {
  const separator = input.lastIndexOf(":");
  const path = input.slice(0, separator);
  const payer = input.slice(separator + 1);
  const text = await readFile(path, "utf8");
  const lines = text.split("\n").slice(1).filter((line) => line.trim());

  for (const [index, line] of lines.entries()) {
    const [date, category, type, amount, description] = parseCsvLine(line);
    let expense;
    try {
      expense = parseExpense({ date, category, type, payer, amount, description });
    } catch (error) {
      failed.push(`${path}:${index + 2}  ${error.field}: ${error.message}`);
      continue;
    }
    const key = fingerprint(expense);
    if (seen.has(key) && !keepDuplicates) {
      dropped.push(`${path}:${index + 2}  ${expense.date} ${expense.category} ` +
        `${(expense.amountOre / 100).toFixed(2)} "${expense.description}"`);
      console.log(`skip      ${expense.date} ${expense.category} ${expense.description} (already there)`);
      continue;
    }
    seen.add(key);
    console.log(`${dryRun ? "would add" : "add     "}  ${expense.date} ${expense.category} ` +
      `${(expense.amountOre / 100).toFixed(2)} ${expense.description}`);
    if (!dryRun) await store.expenses.add(expense, "import");
    added += 1;
  }
}

console.log(`\n${dryRun ? "would add" : "added"} ${added}, ` +
  `dropped as duplicates ${dropped.length}, failed ${failed.length}`);
for (const row of dropped) console.log(`  dropped ${row}`);
for (const problem of failed) console.log(`  failed  ${problem}`);
if (dropped.length) {
  console.log("\nThose rows were already in the data, so they were left out and the balance");
  console.log("no longer counts them. Re-run with --keep-duplicates to import verbatim.");
}
if (dryRun) console.log("\ndry run - nothing was written");
