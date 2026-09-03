/**
 * Azure Functions bindings.
 *
 * This file is only an adapter: it maps the Functions runtime's request and
 * response shapes onto the plain handlers in lib/handlers.js, which is where
 * the behaviour lives. Keeping the runtime out of the handlers is what lets
 * the same code be tested with `node --test` and run locally without the
 * Functions host.
 */

import { app } from "@azure/functions";
import * as handlers from "./lib/handlers.js";
import { guard } from "./lib/http.js";
import { createStore } from "./lib/tables.js";

let store;
function getStore() {
  if (!store) store = createStore();
  return store;
}

/** Functions HttpRequest -> the shape our handlers expect. */
function adapt(request) {
  return {
    method: request.method,
    headers: request.headers,
    query: request.query,
    params: request.params,
    text: () => request.text(),
  };
}

function register(name, { route, methods, handler, authLevel = "anonymous" }) {
  app.http(name, {
    methods,
    authLevel,
    route,
    handler: guard(async (request, context) => handler(adapt(request), { store: getStore(), context })),
  });
}

register("me", { route: "me", methods: ["GET"], handler: handlers.getMe });

register("listExpenses", { route: "expenses", methods: ["GET"], handler: handlers.listExpenses });
register("createExpense", { route: "expenses", methods: ["POST"], handler: handlers.createExpense });
register("deleteExpense", { route: "expenses/{id}", methods: ["DELETE"], handler: handlers.deleteExpense });
register("exportExpenses", { route: "expenses/export", methods: ["GET"], handler: handlers.exportExpenses });
register("importExpenses", { route: "expenses/import", methods: ["POST"], handler: handlers.importExpenses });

register("listPosts", { route: "posts", methods: ["GET"], handler: handlers.listPosts });
register("savePost", { route: "posts", methods: ["POST"], handler: handlers.savePost });
register("getPost", { route: "posts/{slug}", methods: ["GET"], handler: handlers.getPost });
register("deletePost", { route: "posts/{slug}", methods: ["DELETE"], handler: handlers.deletePost });
