/**
 * Money: parsing, the settlement rule, and the CSV shape the old files used.
 *
 * Everything is integer ore (1/100 kr). There is no floating point anywhere in
 * this file, because 0.1 + 0.2 must not happen to somebody's rent.
 *
 * The rule, stated once:
 *   - `payer`  (y|v) is who put the money down.
 *   - `type`   (y|v|f) is whose expense it is: Yao's, Vollum's, or felles
 *     (shared half and half).
 *   - The payer is credited the full amount; the cost is charged to whoever it
 *     belongs to, split in two when it is felles.
 *   - The balance is the net of what one has paid on the other's behalf.
 */

export const PEOPLE = { y: "Yao", v: "Vollum" };
export const TYPES = { y: "Yao only", v: "Vollum only", f: "Shared 50/50" };

export const MAX_ORE = 100000000; // 1 000 000 kr - anything larger is a typo

const CURRENCY_JUNK = /\b(kr|nok)\b|[€$£¥]/gi;
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001F\\u007F]", "g");
const ODD_SPACES = new RegExp("[\\u00A0\\u2007\\u2009\\u202F]", "g");
const UNICODE_MINUS = new RegExp("\\u2212", "g");

export class FieldError extends Error {
  constructor(field, message) {
    super(message);
    this.field = field;
    this.status = 400;
  }
}

/** "526", "12,50", "1 250.00", "kr 99", "99,-" -> integer ore. */
export function parseAmount(input) {
  if (input === null || input === undefined || input === "") {
    throw new FieldError("amount", "amount is required");
  }
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw new FieldError("amount", "amount must be a number");
    return checkOre(Math.round(input * 100));
  }
  let text = String(input).replace(ODD_SPACES, " ").replace(UNICODE_MINUS, "-");
  text = text.replace(CURRENCY_JUNK, "");
  text = text.replace(/[\s']/g, "");
  text = text.replace(/[.,]-$/, ""); // Norwegian "99,-"
  if (!text) throw new FieldError("amount", "amount is required");

  if (text.includes(",") && text.includes(".")) {
    // Whichever separator comes last is the decimal one.
    text = text.lastIndexOf(",") > text.lastIndexOf(".")
      ? text.replace(/\./g, "").replace(",", ".")
      : text.replace(/,/g, "");
  } else if ((text.match(/,/g) || []).length === 1 && text.split(",")[1].length !== 3) {
    text = text.replace(",", ".");   // decimal comma: 12,50
  } else {
    text = text.replace(/,/g, "");   // thousands group: 1,250
  }

  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new FieldError("amount", `"${input}" is not a number`);
  }
  const [whole, fraction = ""] = text.split(".");
  const ore = Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
  // Round the third decimal half up rather than truncating it away.
  const third = fraction.length > 2 ? Number(fraction[2]) : 0;
  return checkOre(ore + (third >= 5 ? 1 : 0));
}

function checkOre(ore) {
  if (!Number.isSafeInteger(ore)) throw new FieldError("amount", "amount is not a usable number");
  if (ore <= 0) throw new FieldError("amount", "amount must be greater than zero");
  if (ore >= MAX_ORE) throw new FieldError("amount", "amount looks like a typo (too large)");
  return ore;
}

/** Integer ore -> "1234.50", the form the CSVs use. */
export function formatKr(ore) {
  const sign = ore < 0 ? "-" : "";
  const abs = Math.abs(ore);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** Accepts YYYYMMDD or YYYY-MM-DD (and "", meaning today) -> YYYYMMDD. */
export function parseDate(input, today = new Date()) {
  if (input === null || input === undefined || String(input).trim() === "") {
    return toYmd(today);
  }
  const text = String(input).trim().toLowerCase();
  if (text === "today") return toYmd(today);
  if (text === "yesterday") return toYmd(new Date(today.getTime() - 86400000));
  const digits = text.replace(/[-/.]/g, "");
  if (!/^\d{8}$/.test(digits)) {
    throw new FieldError("date", `"${input}" is not a date (use YYYY-MM-DD)`);
  }
  const year = Number(digits.slice(0, 4));
  const month = Number(digits.slice(4, 6));
  const day = Number(digits.slice(6, 8));
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new FieldError("date", `"${input}" is not a real date`);
  }
  if (year < 2000) throw new FieldError("date", "date is implausibly old");
  const tomorrow = new Date(today.getTime() + 86400000);
  if (digits > toYmd(tomorrow)) throw new FieldError("date", "date is in the future");
  return digits;
}

function toYmd(date) {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("");
}

/** One cell of a CSV row: no newlines, no quotes, no leading formula trigger. */
export function cleanText(value, field, maxLength = 200) {
  const text = String(value ?? "")
    .normalize("NFC")
    .replace(CONTROL_CHARS, " ")
    .replace(/"/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length > maxLength) {
    throw new FieldError(field, `${field} is longer than ${maxLength} characters`);
  }
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

export function parseChoice(value, allowed, field) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(allowed, text)) {
    throw new FieldError(field, `${field} must be one of ${Object.keys(allowed).join(", ")}`);
  }
  return text;
}

/** Validate an expense coming from the browser. Throws FieldError. */
export function parseExpense(payload, { today } = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new FieldError("body", "expected a JSON object");
  }
  const category = cleanText(payload.category, "category", 40).toLowerCase();
  if (!category) throw new FieldError("category", "category is required");
  return {
    date: parseDate(payload.date, today),
    category,
    type: parseChoice(payload.type, TYPES, "type"),
    payer: parseChoice(payload.payer, PEOPLE, "payer"),
    amountOre: parseAmount(payload.amount),
    description: cleanText(payload.description, "description"),
  };
}

/**
 * How much of one row each person is responsible for, in HALF ore.
 *
 * Splitting a felles row in two can land on half an ore. Rounding that away
 * per row would make the balance drift from the total, and would make this
 * disagree with run.py in the money repo, which keeps exact halves and rounds
 * once at the end. So nothing is rounded here: the unit is half an ore, every
 * value stays a whole number, and rounding happens only when a figure is
 * formatted for a human.
 */
export function shareHalfOre(expense) {
  if (expense.type === "f") {
    return { y: expense.amountOre, v: expense.amountOre };
  }
  return {
    y: expense.type === "y" ? expense.amountOre * 2 : 0,
    v: expense.type === "v" ? expense.amountOre * 2 : 0,
  };
}

/** Half ore -> ore, rounded half up on the magnitude (never banker's). */
export function halfOreToOre(halfOre) {
  const sign = halfOre < 0 ? -1 : 1;
  return sign * Math.floor((Math.abs(halfOre) + 1) / 2);
}

export function other(person) {
  return person === "y" ? "v" : "y";
}

/** Balance, per-person figures, and the totals the admin page shows. */
export function settle(expenses) {
  // Everything below is in half ore, so a 50/50 split is always exact.
  const paid = { y: 0, v: 0 };
  const borne = { y: 0, v: 0 };
  const byCategory = new Map();
  const byMonth = new Map();
  let total = 0;

  for (const expense of expenses) {
    paid[expense.payer] += expense.amountOre * 2;
    const share = shareHalfOre(expense);
    borne.y += share.y;
    borne.v += share.v;
    total += expense.amountOre;
    byCategory.set(expense.category, (byCategory.get(expense.category) ?? 0) + expense.amountOre);
    const month = `${expense.date.slice(0, 4)}-${expense.date.slice(4, 6)}`;
    byMonth.set(month, (byMonth.get(month) ?? 0) + expense.amountOre);
  }

  const net = paid.y - borne.y; // positive: Vollum owes Yao
  const creditor = net >= 0 ? "y" : "v";
  const debtor = other(creditor);
  const settled = net === 0;

  return {
    count: expenses.length,
    total: formatKr(total),
    people: Object.fromEntries(
      Object.keys(PEOPLE).map((person) => [
        person,
        {
          name: PEOPLE[person],
          paid: formatKr(halfOreToOre(paid[person])),
          borne: formatKr(halfOreToOre(borne[person])),
          net: formatKr(halfOreToOre(paid[person] - borne[person])),
        },
      ])
    ),
    balance: {
      amount: formatKr(halfOreToOre(Math.abs(net))),
      creditor,
      debtor,
      creditorName: PEOPLE[creditor],
      debtorName: PEOPLE[debtor],
      settled,
      sentence: settled
        ? "All square"
        : `${PEOPLE[debtor]} owes ${PEOPLE[creditor]} ${formatKr(halfOreToOre(Math.abs(net)))} kr`,
    },
    byCategory: [...byCategory.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([category, ore]) => ({ category, total: formatKr(ore) })),
    byMonth: [...byMonth.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([month, ore]) => ({ month, total: formatKr(ore) })),
  };
}

/** What makes two rows "the same expense", for the duplicate guard. */
export function fingerprint(expense) {
  return [
    expense.date,
    expense.category,
    expense.type,
    expense.payer,
    String(expense.amountOre),
    expense.description.toLowerCase(),
  ].join("|");
}

export function findDuplicates(expenses) {
  const groups = new Map();
  for (const expense of expenses) {
    const key = fingerprint(expense);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(expense);
  }
  return [...groups.values()]
    .filter((group) => group.length > 1)
    .map((group) => ({
      count: group.length,
      date: group[0].date,
      category: group[0].category,
      amount: formatKr(group[0].amountOre),
      description: group[0].description,
      ids: group.map((item) => item.id),
    }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

/** The CSV the old yao.csv / vollum.csv used, so run.py keeps working. */
export function toCsv(expenses, payer) {
  const rows = expenses
    .filter((expense) => expense.payer === payer)
    .sort((a, b) => b.date.localeCompare(a.date))
    .map(
      (expense) =>
        `${expense.date}, ${expense.category}, ${expense.type}, ` +
        `${formatKr(expense.amountOre)}, "${expense.description}"`
    );
  return ["date, category, type, amount, description", ...rows].join("\n") + "\n";
}
