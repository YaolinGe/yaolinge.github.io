/**
 * The API, as plain functions.
 *
 * Each handler takes a small request object and the store, and returns a
 * response. Nothing here imports the Azure Functions runtime, so the same code
 * runs under `func start`, under the local dev server, and under `node --test`.
 */

import { HttpError, json, readJson, text } from "./http.js";
import { ROLE_MONEY, ROLE_OWNER, authorLabel, readPrincipal, requireRole } from "./principal.js";
import { renderMarkdown, summarise } from "./markdown.js";
import { isValidSlug, slugify } from "./slug.js";
import {
  PEOPLE,
  TYPES,
  cleanText,
  fingerprint,
  findDuplicates,
  parseDate,
  parseExpense,
  settle,
  toCsv,
} from "./money.js";

const DEFAULT_CATEGORIES = [
  "grocery", "food", "transport", "sameiet", "electricity", "kommune",
  "health", "sport", "travel", "gift", "misc",
];

/* -- identity ---------------------------------------------------------- */

export async function getMe(request) {
  const principal = readPrincipal(request.headers);
  if (!principal) return json(200, { signedIn: false });
  return json(200, {
    signedIn: true,
    userDetails: principal.userDetails,
    identityProvider: principal.identityProvider,
    roles: principal.roles,
    canWriteMoney: principal.roles.includes(ROLE_MONEY) || principal.roles.includes(ROLE_OWNER),
    canWriteBlog: principal.roles.includes(ROLE_OWNER),
  });
}

/* -- money ------------------------------------------------------------- */

async function moneyState(store) {
  const expenses = await store.expenses.list();
  return {
    expenses: expenses.map(toExpenseJson),
    settlement: settle(expenses),
    duplicates: findDuplicates(expenses),
    people: PEOPLE,
    types: TYPES,
    categories: [...new Set([...expenses.map((item) => item.category), ...DEFAULT_CATEGORIES])].sort(),
  };
}

function toExpenseJson(expense) {
  return {
    id: expense.id,
    date: expense.date,
    isoDate: `${expense.date.slice(0, 4)}-${expense.date.slice(4, 6)}-${expense.date.slice(6)}`,
    category: expense.category,
    type: expense.type,
    payer: expense.payer,
    amount: (expense.amountOre / 100).toFixed(2),
    description: expense.description,
    createdBy: expense.createdBy,
  };
}

export async function listExpenses(request, { store }) {
  requireRole(request.headers, [ROLE_MONEY, ROLE_OWNER]);
  return json(200, await moneyState(store));
}

export async function createExpense(request, { store }) {
  const principal = requireRole(request.headers, [ROLE_MONEY, ROLE_OWNER]);
  const payload = await readJson(request);
  const expense = parseExpense(payload);

  const existing = await store.expenses.list();
  const target = fingerprint(expense);
  const clashes = existing.filter((item) => fingerprint(item) === target);
  if (clashes.length && !payload.allowDuplicate) {
    throw new HttpError(409, "an identical row already exists", {
      duplicateOf: clashes.map(toExpenseJson),
      hint: "send allowDuplicate to record it anyway",
    });
  }

  const saved = await store.expenses.add(expense, authorLabel(principal));
  return json(201, { entry: toExpenseJson(saved), ...(await moneyState(store)) });
}

export async function deleteExpense(request, { store }) {
  requireRole(request.headers, [ROLE_MONEY, ROLE_OWNER]);
  const id = request.params?.id;
  if (!id) throw new HttpError(400, "which row?");
  const removed = await store.expenses.get(id);
  if (!removed) throw new HttpError(404, "no row with that id");
  await store.expenses.remove(id);
  return json(200, { removed: toExpenseJson(removed), ...(await moneyState(store)) });
}

/** The CSV the old files used, so run.py in the money repo still works. */
export async function exportExpenses(request, { store }) {
  requireRole(request.headers, [ROLE_MONEY, ROLE_OWNER]);
  const payer = request.query?.get("payer");
  if (!payer || !Object.prototype.hasOwnProperty.call(PEOPLE, payer)) {
    throw new HttpError(400, `payer must be one of ${Object.keys(PEOPLE).join(", ")}`);
  }
  const expenses = await store.expenses.list();
  return text(200, toCsv(expenses, payer), "text/csv; charset=utf-8");
}

/** One-time (or repeatable) load of rows from the old CSVs. Owner only. */
export async function importExpenses(request, { store }) {
  const principal = requireRole(request.headers, ROLE_OWNER);
  const payload = await readJson(request);
  if (!Array.isArray(payload?.rows)) throw new HttpError(400, "expected { rows: [...] }");
  if (payload.rows.length > 2000) throw new HttpError(413, "import at most 2000 rows at a time");

  const existing = await store.expenses.list();
  const seen = new Set(existing.map(fingerprint));
  const added = [];
  const skipped = [];
  const failed = [];

  for (const [index, row] of payload.rows.entries()) {
    let expense;
    try {
      expense = parseExpense(row);
    } catch (error) {
      failed.push({ index, error: error.message, field: error.field });
      continue;
    }
    const key = fingerprint(expense);
    if (seen.has(key) && !payload.allowDuplicate) {
      skipped.push({ index, reason: "already imported" });
      continue;
    }
    seen.add(key);
    added.push(await store.expenses.add(expense, `import by ${authorLabel(principal)}`));
  }
  return json(200, {
    added: added.length,
    skipped: skipped.length,
    failed,
    ...(await moneyState(store)),
  });
}

/* -- blog -------------------------------------------------------------- */

export async function listPosts(request, { store }) {
  const principal = readPrincipal(request.headers);
  const includeDrafts = Boolean(principal?.roles.includes(ROLE_OWNER)) &&
    request.query?.get("drafts") === "1";
  return json(200, { posts: await store.posts.list({ includeDrafts }) });
}

export async function getPost(request, { store }) {
  const slug = request.params?.slug;
  if (!isValidSlug(slug)) throw new HttpError(400, "that is not a valid slug");
  const post = await store.posts.get(slug);
  if (!post) throw new HttpError(404, "no post with that name");
  if (post.status !== "published") {
    // Drafts exist only for the person writing them.
    requireRole(request.headers, ROLE_OWNER);
  }
  return json(200, { post });
}

export async function savePost(request, { store }) {
  const principal = requireRole(request.headers, ROLE_OWNER);
  const payload = await readJson(request);

  const title = cleanText(payload?.title, "title", 120);
  if (!title) throw new HttpError(400, "a post needs a title");
  const slug = payload?.slug ? String(payload.slug).trim() : slugify(title);
  if (!isValidSlug(slug)) throw new HttpError(400, "that slug has characters a URL cannot use");
  const status = payload?.status === "published" ? "published" : "draft";
  const markdown = String(payload?.markdown ?? "");
  if (!markdown.trim()) throw new HttpError(400, "a post needs some words in it");

  const ymd = parseDate(payload?.date ?? "");
  const date = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6)}`;

  const saved = await store.posts.save({
    slug,
    title,
    date,
    status,
    markdown,
    html: renderMarkdown(markdown),
    summary: summarise(markdown),
    author: authorLabel(principal),
  });
  return json(200, { post: saved });
}

export async function deletePost(request, { store }) {
  requireRole(request.headers, ROLE_OWNER);
  const slug = request.params?.slug;
  if (!isValidSlug(slug)) throw new HttpError(400, "that is not a valid slug");
  if (!(await store.posts.remove(slug))) throw new HttpError(404, "no post with that name");
  return json(200, { removed: slug });
}
