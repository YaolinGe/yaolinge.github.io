/**
 * The route table, shared by the local dev server and the tests.
 *
 * Azure Functions owns routing in production (see src/index.js); this is the
 * same table in a form a plain Node server can use, so what runs locally is
 * the same set of paths and methods.
 */

import * as handlers from "./handlers.js";

export const ROUTES = [
  { method: "GET", pattern: /^\/api\/me$/, handler: handlers.getMe },

  { method: "GET", pattern: /^\/api\/expenses\/export$/, handler: handlers.exportExpenses },
  { method: "POST", pattern: /^\/api\/expenses\/import$/, handler: handlers.importExpenses },
  { method: "GET", pattern: /^\/api\/expenses$/, handler: handlers.listExpenses },
  { method: "POST", pattern: /^\/api\/expenses$/, handler: handlers.createExpense },
  { method: "DELETE", pattern: /^\/api\/expenses\/(?<id>[^/]+)$/, handler: handlers.deleteExpense },

  { method: "GET", pattern: /^\/api\/posts$/, handler: handlers.listPosts },
  { method: "POST", pattern: /^\/api\/posts$/, handler: handlers.savePost },
  { method: "GET", pattern: /^\/api\/posts\/(?<slug>[^/]+)$/, handler: handlers.getPost },
  { method: "DELETE", pattern: /^\/api\/posts\/(?<slug>[^/]+)$/, handler: handlers.deletePost },
];

export function match(method, pathname) {
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const found = route.pattern.exec(pathname);
    if (found) return { handler: route.handler, params: found.groups ?? {} };
  }
  return null;
}
