import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AuthError, authorLabel, readPrincipal, requireRole } from "../src/lib/principal.js";
import { isValidSlug, slugify } from "../src/lib/slug.js";

const headers = (value) => ({ get: (name) => (name === "x-ms-client-principal" ? value : undefined) });
const encode = (object) => Buffer.from(JSON.stringify(object)).toString("base64");

const owner = encode({
  userId: "u1", userDetails: "yao", identityProvider: "github",
  userRoles: ["anonymous", "authenticated", "owner", "money"],
});

describe("reading the Static Web Apps principal", () => {
  it("reads a signed-in user", () => {
    const principal = readPrincipal(headers(owner));
    assert.equal(principal.userDetails, "yao");
    assert.deepEqual(principal.roles, ["anonymous", "authenticated", "owner", "money"]);
  });

  it("treats anything malformed as nobody", () => {
    for (const value of [undefined, "", "not base64 at all !!", encode({}), encode([1, 2]),
                         encode({ userId: "u1", userRoles: ["anonymous"] })]) {
      assert.equal(readPrincipal(headers(value)), null, String(value));
    }
  });

  it("does not trust a principal that never authenticated", () => {
    const forged = encode({ userId: "u9", userRoles: ["owner", "money"] });
    assert.equal(readPrincipal(headers(forged)), null);
  });
});

describe("role checks", () => {
  it("lets the right role through", () => {
    assert.equal(requireRole(headers(owner), "owner").userId, "u1");
    assert.equal(requireRole(headers(owner), ["money", "owner"]).userId, "u1");
  });

  it("401s anonymous and 403s the wrong role", () => {
    assert.throws(() => requireRole(headers(undefined), "owner"), (error) => error.status === 401);
    const partner = encode({
      userId: "u2", userDetails: "partner", userRoles: ["anonymous", "authenticated", "money"],
    });
    assert.throws(() => requireRole(headers(partner), "owner"), (error) => error.status === 403);
    assert.equal(requireRole(headers(partner), "money").userDetails, "partner");
  });

  it("labels the author by display name", () => {
    assert.equal(authorLabel(readPrincipal(headers(owner))), "yao");
    assert.equal(authorLabel({ userId: "u3", userDetails: "" }), "u3");
  });

  it("is an AuthError, so the HTTP layer can map it", () => {
    assert.throws(() => requireRole(headers(undefined), "owner"), AuthError);
  });
});

describe("slugs", () => {
  it("makes a URL out of a title", () => {
    assert.equal(slugify("Notes for reading DDIA"), "notes-for-reading-ddia");
    assert.equal(slugify("Topptur pa Gaustatoppen!"), "topptur-pa-gaustatoppen");
    assert.equal(slugify("C# async & await"), "c-async-await");
  });

  it("folds the Norwegian letters rather than dropping them", () => {
    assert.equal(slugify("Skitur i Ålesund"), "skitur-i-alesund");
    assert.equal(slugify("Øvre Forsland"), "ovre-forsland");
  });

  it("rejects what cannot be a slug", () => {
    for (const value of ["", "   ", "-leading", "has space", "UPPER", "a/b", undefined]) {
      assert.equal(isValidSlug(value), false, String(value));
    }
    assert.equal(isValidSlug("a-good-slug-2026"), true);
  });
});
