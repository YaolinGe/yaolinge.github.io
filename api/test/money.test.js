import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  FieldError, findDuplicates, formatKr, parseAmount, parseDate, parseExpense,
  halfOreToOre, settle, shareHalfOre, toCsv,
} from "../src/lib/money.js";

const row = (amountOre, type, payer, extra = {}) => ({
  date: "20260101", category: "food", description: "", ...extra, amountOre, type, payer,
});

describe("parsing amounts", () => {
  it("takes the shapes a person actually types", () => {
    const cases = {
      "526": 52600, "12,50": 1250, "1 250.00": 125000, "1.234,50": 123450,
      "1,234.50": 123450, "kr 99": 9900, "99,-": 9900, "110.6": 11060, "1,250": 125000,
    };
    for (const [input, expected] of Object.entries(cases)) {
      assert.equal(parseAmount(input), expected, input);
    }
  });

  it("rounds a third decimal half up", () => {
    assert.equal(parseAmount("0.005"), 1);
    assert.equal(parseAmount("10.004"), 1000);
  });

  it("refuses what is not an amount", () => {
    for (const input of ["", null, undefined, "abc", "0", "-5", "1e5", "9999999", {}]) {
      assert.throws(() => parseAmount(input), FieldError, String(input));
    }
  });

  it("formats back to two decimals", () => {
    assert.equal(formatKr(123450), "1234.50");
    assert.equal(formatKr(5), "0.05");
    assert.equal(formatKr(0), "0.00");
  });
});

describe("parsing dates", () => {
  it("accepts both shapes and defaults to today", () => {
    assert.equal(parseDate("2026-07-08"), "20260708");
    assert.equal(parseDate("20260708"), "20260708");
    assert.equal(parseDate("", new Date("2026-09-03T10:00:00Z")), "20260903");
  });

  it("refuses impossible and future dates", () => {
    const today = new Date("2026-09-03T10:00:00Z");
    for (const input of ["08-07-2026", "20261308", "2026-02-30", "nope", "1999-01-01", "2027-01-01"]) {
      assert.throws(() => parseDate(input, today), FieldError, input);
    }
  });
});

describe("validating a submitted row", () => {
  const good = { amount: "526", category: "Food", type: "f", payer: "y", date: "2026-07-08" };

  it("normalises what it keeps", () => {
    const expense = parseExpense(good);
    assert.deepEqual(expense, {
      date: "20260708", category: "food", type: "f", payer: "y",
      amountOre: 52600, description: "",
    });
  });

  it("names the field that is wrong", () => {
    const cases = [
      [{ ...good, amount: "abc" }, "amount"],
      [{ ...good, type: "x" }, "type"],
      [{ ...good, payer: "z" }, "payer"],
      [{ ...good, category: "" }, "category"],
      [{ ...good, date: "08-07-2026" }, "date"],
    ];
    for (const [payload, field] of cases) {
      assert.throws(() => parseExpense(payload), (error) => error.field === field, field);
    }
  });

  it("keeps a description from breaking the CSV shape", () => {
    const expense = parseExpense({ ...good, description: 'a "quoted"\nnote' });
    assert.equal(expense.description, "a 'quoted' note");
    assert.equal(parseExpense({ ...good, description: "=1+1" }).description, "'=1+1");
  });
});

describe("the settlement rule", () => {
  it("splits a shared row in half", () => {
    // Half ore: 100.00 kr is 20000 half ore, so 10000 each.
    assert.deepEqual(shareHalfOre(row(10000, "f", "y")), { y: 10000, v: 10000 });
  });

  it("charges a personal row to that person alone", () => {
    assert.deepEqual(shareHalfOre(row(10000, "v", "y")), { y: 0, v: 20000 });
  });

  it("splits an odd ore exactly instead of rounding per row", () => {
    const split = shareHalfOre(row(101, "f", "v"));
    assert.equal(split.v + split.y, 101 * 2);
    assert.equal(split.v, 101);          // 50.5 ore, held exactly
  });

  it("rounds half up on the magnitude, not banker's", () => {
    assert.equal(halfOreToOre(5), 3);    // 2.5 ore -> 3
    assert.equal(halfOreToOre(7), 4);    // 3.5 ore -> 4
    assert.equal(halfOreToOre(-5), -3);
    assert.equal(halfOreToOre(4), 2);
  });

  it("moves the balance by half of a shared row", () => {
    const report = settle([row(10000, "f", "y")]);
    assert.equal(report.balance.amount, "50.00");
    assert.equal(report.balance.debtor, "v");
  });

  it("moves it by the whole amount when paying for the other person", () => {
    assert.equal(settle([row(10000, "v", "y")]).balance.amount, "100.00");
  });

  it("does not move when paying for yourself", () => {
    assert.equal(settle([row(10000, "y", "y")]).balance.settled, true);
  });

  it("flips direction", () => {
    assert.equal(settle([row(10000, "y", "v")]).balance.debtorName, "Yao");
  });

  it("cancels opposite rows", () => {
    assert.equal(settle([row(10000, "v", "y"), row(10000, "y", "v")]).balance.settled, true);
  });

  it("keeps paid and borne in balance", () => {
    const rows = [row(10000, "f", "y"), row(5000, "v", "y"), row(2501, "y", "v")];
    const report = settle(rows);
    const paid = Object.values(report.people).reduce((sum, person) => sum + Number(person.paid), 0);
    const borne = Object.values(report.people).reduce((sum, person) => sum + Number(person.borne), 0);
    assert.equal(paid.toFixed(2), borne.toFixed(2));
    assert.equal(report.total, "175.01");
  });

  it("totals by category and month", () => {
    const report = settle([
      row(10000, "f", "y", { category: "food", date: "20260115" }),
      row(5000, "f", "y", { category: "grocery", date: "20260215" }),
      row(2500, "f", "y", { category: "food", date: "20260216" }),
    ]);
    assert.deepEqual(report.byCategory[0], { category: "food", total: "125.00" });
    assert.deepEqual(report.byMonth, [
      { month: "2026-01", total: "100.00" },
      { month: "2026-02", total: "75.00" },
    ]);
  });

  it("handles an empty ledger", () => {
    const report = settle([]);
    assert.equal(report.balance.settled, true);
    assert.equal(report.total, "0.00");
  });

  it("reproduces the balance of the real files", () => {
    // The 28 rows that were in yao.csv + vollum.csv when this moved to Azure.
    const real = [
      ...[["20260701","sameiet","v",235800],["20260708","food","f",52600],
          ["20260708","game","f",26000],["20260708","transport","f",188800],
          ["20260706","grocery","f",11060],["20260704","camping","f",58000],
          ["20260704","grocery","f",21525],["20260704","grocery","f",17105],
          ["20260703","grocery","f",63135],["20260701","sameiet","v",235800],
          ["20260629","biltema","v",105070],["20260629","health","f",119900],
          ["20260618","electricity","v",25149],["20260615","kommune","v",128600],
          ["20260612","electricity","v",29732],["20260601","sameiet","v",235800],
          ["20260521","electricity","v",21770],["20260515","electricity","v",37666],
          ["20260515","kommune","v",128600],["20260501","sameiet","v",235800],
          ["20260420","electricity","v",28622],["20260418","misc","v",14990],
          ["20260415","kommune","v",174100],["20260413","sport","f",165200],
          ["20260411","electricity","v",36015],["20260401","sameiet","v",216000]]
        .map(([date, category, type, amountOre]) => row(amountOre, type, "y", { date, category })),
      ...[["20260711","grocery","f",120000],["20260708","food","f",52600]]
        .map(([date, category, type, amountOre]) => row(amountOre, type, "v", { date, category })),
    ];
    const report = settle(real);
    assert.equal(report.count, 28);
    assert.equal(report.people.y.paid, "26128.39");
    assert.equal(report.people.v.paid, "1726.00");
    assert.equal(report.balance.sentence, "Vollum owes Yao 21648.77 kr");
  });
});

describe("duplicates", () => {
  it("finds the same row twice", () => {
    const found = findDuplicates([
      { ...row(10000, "f", "y"), id: "a" },
      { ...row(10000, "f", "y"), id: "b" },
    ]);
    assert.equal(found.length, 1);
    assert.deepEqual(found[0].ids, ["a", "b"]);
  });

  it("does not confuse different rows", () => {
    assert.deepEqual(
      findDuplicates([
        { ...row(10000, "f", "y"), id: "a" },
        { ...row(10000, "f", "y", { description: "other" }), id: "b" },
      ]),
      []
    );
  });
});

describe("the CSV export", () => {
  it("matches the format run.py reads", () => {
    const csv = toCsv(
      [row(52600, "f", "y", { date: "20260708", description: "Lunch" }),
       row(120000, "f", "v", { date: "20260711" })],
      "y"
    );
    assert.equal(csv, 'date, category, type, amount, description\n20260708, food, f, 526.00, "Lunch"\n');
  });

  it("is newest first", () => {
    const csv = toCsv([
      row(100, "f", "y", { date: "20260101" }),
      row(200, "f", "y", { date: "20260301" }),
    ], "y");
    assert.match(csv.split("\n")[1], /^20260301/);
  });
});
