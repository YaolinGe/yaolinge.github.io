/** The storage layer, against a real Azure Tables service (Azurite). */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { startAzurite } from "./helpers.mjs";
import { createStore } from "../src/lib/tables.js";

let azurite;
let store;

before(async () => {
  azurite = await startAzurite(10201);
  store = createStore({ connectionString: azurite.connectionString, prefix: "store" });
  await store.ensure();
});

after(async () => {
  await azurite?.stop();
});

const expense = (extra = {}) => ({
  date: "20260708", category: "food", type: "f", payer: "y",
  amountOre: 52600, description: "lunch", ...extra,
});

describe("expenses in table storage", () => {
  it("round-trips an amount as an exact integer, not a float", async () => {
    const saved = await store.expenses.add(expense({ amountOre: 21525 }), "yao");
    const found = await store.expenses.get(saved.id);
    assert.equal(found.amountOre, 21525);
    assert.equal(Number.isInteger(found.amountOre), true);
    await store.expenses.remove(saved.id);
  });

  it("survives the largest amount we allow", async () => {
    const saved = await store.expenses.add(expense({ amountOre: 99999999 }), "yao");
    assert.equal((await store.expenses.get(saved.id)).amountOre, 99999999);
    await store.expenses.remove(saved.id);
  });

  it("lists newest first", async () => {
    const ids = [];
    for (const date of ["20260101", "20260301", "20260201"]) {
      ids.push((await store.expenses.add(expense({ date }), "yao")).id);
    }
    const listed = await store.expenses.list();
    assert.deepEqual(listed.map((item) => item.date), ["20260301", "20260201", "20260101"]);
    for (const id of ids) await store.expenses.remove(id);
  });

  it("keeps who wrote the row", async () => {
    const saved = await store.expenses.add(expense(), "partner");
    assert.equal((await store.expenses.get(saved.id)).createdBy, "partner");
    await store.expenses.remove(saved.id);
  });

  it("reports a missing row rather than throwing", async () => {
    assert.equal(await store.expenses.get("no-such-id"), null);
    assert.equal(await store.expenses.remove("no-such-id"), false);
  });
});

describe("posts in table storage", () => {
  const post = (extra = {}) => ({
    slug: "hello-world", title: "Hello world", date: "2026-09-01", status: "published",
    markdown: "# hi", html: "<h1>hi</h1>", summary: "hi", author: "yao", ...extra,
  });

  it("saves and reads a post back whole", async () => {
    await store.posts.save(post());
    const found = await store.posts.get("hello-world");
    assert.equal(found.title, "Hello world");
    assert.equal(found.markdown, "# hi");
    assert.equal(found.html, "<h1>hi</h1>");
    await store.posts.remove("hello-world");
  });

  it("stores a post longer than one table property can hold", async () => {
    // A single Table Storage property tops out at 64 KiB.
    const long = "x".repeat(90000);
    await store.posts.save(post({ slug: "long-one", markdown: long, html: `<p>${long}</p>` }));
    const found = await store.posts.get("long-one");
    assert.equal(found.markdown.length, 90000);
    assert.equal(found.html.length, 90007);
    await store.posts.remove("long-one");
  });

  it("does not leave stale text behind when a post gets shorter", async () => {
    await store.posts.save(post({ slug: "shrink", markdown: "y".repeat(60000) }));
    await store.posts.save(post({ slug: "shrink", markdown: "short" }));
    assert.equal((await store.posts.get("shrink")).markdown, "short");
    await store.posts.remove("shrink");
  });

  it("refuses a post too large for one entity", async () => {
    await assert.rejects(
      () => store.posts.save(post({ slug: "huge", markdown: "z".repeat(500000) })),
      (error) => error.status === 413
    );
  });

  it("hides drafts from the public list but keeps them for the writer", async () => {
    await store.posts.save(post({ slug: "a-draft", status: "draft" }));
    await store.posts.save(post({ slug: "published-one", status: "published" }));
    const publicList = await store.posts.list();
    const fullList = await store.posts.list({ includeDrafts: true });
    assert.deepEqual(publicList.map((item) => item.slug), ["published-one"]);
    assert.equal(fullList.length, 2);
    await store.posts.remove("a-draft");
    await store.posts.remove("published-one");
  });

  it("keeps createdAt across an edit and moves updatedAt", async () => {
    const first = await store.posts.save(post({ slug: "edited" }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await store.posts.save(post({ slug: "edited", title: "Changed" }));
    assert.equal(second.createdAt, first.createdAt);
    assert.notEqual(second.updatedAt, first.updatedAt);
    await store.posts.remove("edited");
  });

  it("keeps the original URL of an imported post when it is edited", async () => {
    await store.posts.save(post({ slug: "old-post", legacyPath: "blogs/2025-01-01-old.html" }));
    await store.posts.save(post({ slug: "old-post", title: "Edited" }));
    assert.equal((await store.posts.get("old-post")).legacyPath, "blogs/2025-01-01-old.html");
    await store.posts.remove("old-post");
  });

  it("reports a missing post rather than throwing", async () => {
    assert.equal(await store.posts.get("nope"), null);
    assert.equal(await store.posts.remove("nope"), false);
  });
});
