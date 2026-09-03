/** The handlers end to end, against a real Azure Tables service (Azurite). */

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { parse, request, startAzurite } from "./helpers.mjs";
import * as handlers from "../src/lib/handlers.js";
import { guard } from "../src/lib/http.js";
import { createStore } from "../src/lib/tables.js";

/**
 * Call a handler the way the server does: wrapped in guard(), so a thrown
 * FieldError or AuthError becomes the same response a browser would get.
 */
const call = (handler, requestObject) => guard(handler)(requestObject, { store });

let azurite;
let store;

before(async () => {
  azurite = await startAzurite(10202);
  store = createStore({ connectionString: azurite.connectionString, prefix: "api" });
  await store.ensure();
});

after(async () => {
  await azurite?.stop();
});

beforeEach(async () => {
  for (const expense of await store.expenses.list()) await store.expenses.remove(expense.id);
  for (const post of await store.posts.list({ includeDrafts: true })) await store.posts.remove(post.slug);
});

const ROW = { amount: "85,50", category: "transport", type: "f", payer: "y",
              date: "2026-07-09", description: "bus to work" };

const add = (body, as = "owner") => call(handlers.createExpense, request({ method: "POST", as, body }));

describe("who am I", () => {
  it("says nothing about an anonymous visitor", async () => {
    const body = parse(await call(handlers.getMe, request()));
    assert.deepEqual(body, { signedIn: false });
  });

  it("reports the roles that matter to the page", async () => {
    const owner = parse(await call(handlers.getMe, request({ as: "owner" })));
    assert.equal(owner.canWriteBlog, true);
    assert.equal(owner.canWriteMoney, true);
    const partner = parse(await call(handlers.getMe, request({ as: "money" })));
    assert.equal(partner.canWriteMoney, true);
    assert.equal(partner.canWriteBlog, false);
  });
});

describe("money", () => {
  it("adds a row and reports the new balance", async () => {
    const response = await add(ROW);
    assert.equal(response.status, 201);
    const body = parse(response);
    assert.equal(body.entry.amount, "85.50");
    assert.equal(body.settlement.balance.amount, "42.75");
    assert.equal(body.settlement.balance.debtorName, "Vollum");
  });

  it("lets the partner add rows too", async () => {
    assert.equal((await add({ ...ROW, payer: "v" }, "money")).status, 201);
    const body = parse(await call(handlers.listExpenses, request({ as: "money" })));
    assert.equal(body.expenses.length, 1);
    assert.equal(body.expenses[0].createdBy, "partner");
  });

  it("names the field when the input is wrong", async () => {
    for (const [payload, field] of [
      [{ ...ROW, amount: "abc" }, "amount"],
      [{ ...ROW, amount: "-5" }, "amount"],
      [{ ...ROW, type: "x" }, "type"],
      [{ ...ROW, payer: "z" }, "payer"],
      [{ ...ROW, category: "" }, "category"],
      [{ ...ROW, date: "09-07-2026" }, "date"],
    ]) {
      const response = await add(payload);
      assert.equal(response.status, 400, field);
      assert.equal(parse(response).field, field);
    }
    assert.equal((await store.expenses.list()).length, 0);
  });

  it("rejects a body that is not JSON", async () => {
    const response = await call(
      handlers.createExpense, request({ method: "POST", as: "owner", body: "{not json" })
    );
    assert.equal(response.status, 400);
    assert.match(parse(response).error, /not valid JSON/);
  });

  it("refuses an identical row until it is confirmed", async () => {
    await add(ROW);
    const clash = await add(ROW);
    assert.equal(clash.status, 409);
    assert.equal(parse(clash).duplicateOf.length, 1);
    assert.equal((await store.expenses.list()).length, 1);

    assert.equal((await add({ ...ROW, allowDuplicate: true })).status, 201);
    assert.equal((await store.expenses.list()).length, 2);
  });

  it("deletes a row and puts the balance back", async () => {
    const created = parse(await add(ROW));
    const response = await call(
      handlers.deleteExpense, request({ method: "DELETE", as: "owner", params: { id: created.entry.id } })
    );
    assert.equal(response.status, 200);
    assert.equal(parse(response).settlement.balance.settled, true);
  });

  it("404s a delete of something that is not there", async () => {
    const response = await call(
      handlers.deleteExpense, request({ method: "DELETE", as: "owner", params: { id: "nope" } })
    );
    assert.equal(response.status, 404);
  });

  it("flags rows recorded twice", async () => {
    await add(ROW);
    await add({ ...ROW, allowDuplicate: true });
    const body = parse(await call(handlers.listExpenses, request({ as: "owner" })));
    assert.equal(body.duplicates.length, 1);
    assert.equal(body.duplicates[0].count, 2);
  });

  it("exports the CSV run.py reads", async () => {
    await add({ ...ROW, payer: "y", description: "Lunch" });
    await add({ ...ROW, payer: "v", description: "Kiwi" });
    const response = await call(handlers.exportExpenses, request({ as: "owner", query: { payer: "y" } }));
    assert.equal(response.headers["Content-Type"], "text/csv; charset=utf-8");
    assert.equal(response.body,
      'date, category, type, amount, description\n20260709, transport, f, 85.50, "Lunch"\n');
  });

  it("wants to know which CSV to export", async () => {
    assert.equal((await call(handlers.exportExpenses, request({ as: "owner" }))).status, 400);
  });

  it("imports rows and does not import them twice", async () => {
    const rows = [
      { date: "20260101", category: "food", type: "f", payer: "y", amount: "100", description: "a" },
      { date: "20260102", category: "food", type: "y", payer: "v", amount: "50,50", description: "b" },
      { date: "nonsense", category: "food", type: "f", payer: "y", amount: "10", description: "c" },
    ];
    const first = parse(await call(
      handlers.importExpenses, request({ method: "POST", as: "owner", body: { rows } })
    ));
    assert.equal(first.added, 2);
    assert.equal(first.failed.length, 1);
    assert.equal(first.failed[0].field, "date");

    const second = parse(await call(
      handlers.importExpenses, request({ method: "POST", as: "owner", body: { rows } })
    ));
    assert.equal(second.added, 0);
    assert.equal(second.skipped, 2);
    assert.equal((await store.expenses.list()).length, 2);
  });
});

describe("who may touch the money", () => {
  it("turns anonymous away", async () => {
    const attempts = [
      [handlers.listExpenses, request()],
      [handlers.createExpense, request({ method: "POST", body: ROW })],
      [handlers.deleteExpense, request({ method: "DELETE", params: { id: "x" } })],
      [handlers.exportExpenses, request({ query: { payer: "y" } })],
    ];
    for (const [handler, requestObject] of attempts) {
      assert.equal((await call(handler, requestObject)).status, 401);
    }
  });

  it("turns away someone signed in with no role", async () => {
    const response = await call(handlers.listExpenses, request({ as: "strangerSignedIn" }));
    assert.equal(response.status, 403);
  });

  it("keeps importing to the owner", async () => {
    const response = await call(
      handlers.importExpenses, request({ method: "POST", as: "money", body: { rows: [] } })
    );
    assert.equal(response.status, 403);
  });
});

describe("blog", () => {
  const POST = { title: "Hello world", markdown: "# hi\n\nsome words", status: "published",
                 date: "2026-09-01" };

  const save = (body, as = "owner") => call(handlers.savePost, request({ method: "POST", as, body }));

  it("saves a post, rendering the markdown once", async () => {
    const body = parse(await save(POST));
    assert.equal(body.post.slug, "hello-world");
    assert.equal(body.post.html, "<h1>hi</h1>\n<p>some words</p>");
    assert.equal(body.post.summary, "hi some words");
    assert.equal(body.post.author, "yao");
  });

  it("lets the public read a published post", async () => {
    await save(POST);
    const body = parse(await call(handlers.getPost, request({ params: { slug: "hello-world" } })));
    assert.equal(body.post.title, "Hello world");
  });

  it("keeps a draft to the writer", async () => {
    await save({ ...POST, slug: "secret", status: "draft" });
    const denied = await call(handlers.getPost, request({ params: { slug: "secret" } }));
    assert.equal(denied.status, 401);
    const allowed = await call(handlers.getPost, request({ as: "owner", params: { slug: "secret" } }));
    assert.equal(allowed.status, 200);
  });

  it("keeps drafts out of the public list", async () => {
    await save({ ...POST, slug: "live" });
    await save({ ...POST, slug: "wip", status: "draft" });
    const publicList = parse(await call(handlers.listPosts, request()));
    assert.deepEqual(publicList.posts.map((post) => post.slug), ["live"]);

    const ownerList = parse(await call(
      handlers.listPosts, request({ as: "owner", query: { drafts: "1" } })
    ));
    assert.equal(ownerList.posts.length, 2);
  });

  it("will not let a reader ask for drafts", async () => {
    await save({ ...POST, slug: "wip", status: "draft" });
    const body = parse(await call(handlers.listPosts, request({ query: { drafts: "1" } })));
    assert.equal(body.posts.length, 0);
  });

  it("refuses a post with no title or no words", async () => {
    for (const payload of [{ ...POST, title: "" }, { ...POST, markdown: "   " }]) {
      assert.equal((await save(payload)).status, 400);
    }
  });

  it("refuses a slug a URL cannot carry", async () => {
    assert.equal((await save({ ...POST, slug: "not a slug/../etc" })).status, 400);
  });

  it("edits in place rather than making a second post", async () => {
    await save(POST);
    await save({ ...POST, slug: "hello-world", title: "Hello again", markdown: "# again" });
    const list = parse(await call(handlers.listPosts, request()));
    assert.equal(list.posts.length, 1);
    assert.equal(list.posts[0].title, "Hello again");
  });

  it("deletes a post", async () => {
    await save(POST);
    const response = await call(
      handlers.deletePost, request({ method: "DELETE", as: "owner", params: { slug: "hello-world" } })
    );
    assert.equal(response.status, 200);
    assert.equal(parse(await call(handlers.listPosts, request())).posts.length, 0);
  });

  it("keeps writing to the owner", async () => {
    assert.equal((await save(POST, "money")).status, 403);
    assert.equal((await call(
      handlers.deletePost, request({ method: "DELETE", as: "money", params: { slug: "x" } })
    )).status, 403);
  });

  it("stores a post that no single table property could hold", async () => {
    const long = `# Long\n\n${"word ".repeat(20000)}`;
    const body = parse(await save({ ...POST, slug: "long-post", markdown: long }));
    assert.ok(body.post.markdown.length > 64 * 1024);
    const read = parse(await call(handlers.getPost, request({ params: { slug: "long-post" } })));
    assert.equal(read.post.markdown, long);
  });
});
