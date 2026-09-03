#!/usr/bin/env node
/**
 * Write yao.csv and vollum.csv from the database, in the format run.py reads.
 *
 *   STORAGE_CONNECTION_STRING="..." node scripts/export-csv.mjs ~/money
 *
 * Azure is the source of truth now; this produces a snapshot so the report in
 * the money repo keeps working and there is a copy in git history. It reads
 * the tables directly rather than the HTTP API, so it needs no sign-in.
 */

import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { createStore } from "../api/src/lib/tables.js";
import { PEOPLE, toCsv } from "../api/src/lib/money.js";

const target = resolve(process.argv[2] ?? ".");
const files = { y: "yao.csv", v: "vollum.csv" };

const store = createStore();
const expenses = await store.expenses.list();

for (const [payer, filename] of Object.entries(files)) {
  const csv = toCsv(expenses, payer);
  const path = join(target, filename);
  await writeFile(path, csv, "utf8");
  const rows = csv.trim().split("\n").length - 1;
  console.log(`wrote ${path}  ${rows} rows for ${PEOPLE[payer]}`);
}
console.log(`\n${expenses.length} rows total. Commit them if you want the snapshot in git.`);
