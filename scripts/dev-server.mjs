#!/usr/bin/env node
/**
 * Run the whole site locally: static files plus the API, the way Azure Static
 * Web Apps serves them.
 *
 *   npx azurite --silent --location .azurite &
 *   node scripts/dev-server.mjs
 *
 * Static Web Apps signs the user in and passes the result to the API in the
 * `x-ms-client-principal` header. There is no login here, so this server
 * fakes that header from --as, and enforces the route rules from
 * staticwebapp.config.json so an unauthorised path 401s locally too.
 */

import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { match } from "../api/src/lib/router.js";
import { toResponse } from "../api/src/lib/http.js";
import { createStore } from "../api/src/lib/tables.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const AZURITE = "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;" +
  "AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;" +
  "TableEndpoint=http://127.0.0.1:10002/devstoreaccount1;";

const argument = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};

const port = Number(argument("port", 4280));
const who = argument("as", "owner"); // owner | money | anonymous

const PRINCIPALS = {
  owner: { userId: "dev-yao", userDetails: "yao (dev)", identityProvider: "github",
    userRoles: ["anonymous", "authenticated", "owner", "money"] },
  money: { userId: "dev-partner", userDetails: "partner (dev)", identityProvider: "github",
    userRoles: ["anonymous", "authenticated", "money"] },
};

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".pdf": "application/pdf",
  ".webp": "image/webp", ".mp4": "video/mp4", ".csv": "text/csv; charset=utf-8",
};

const config = JSON.parse(await readFile(join(ROOT, "staticwebapp.config.json"), "utf8"));
const store = createStore({
  connectionString: process.env.STORAGE_CONNECTION_STRING ?? AZURITE,
  prefix: process.env.TABLE_PREFIX ?? "dev",
});

/** The same route rules Azure applies, so local behaviour is not more lenient. */
function routeRule(pathname) {
  return (config.routes ?? []).find((rule) => {
    if (!rule.route) return false;
    if (rule.route.endsWith("/*")) return pathname.startsWith(rule.route.slice(0, -1));
    return rule.route === pathname;
  });
}

function allowed(rule, roles) {
  if (!rule?.allowedRoles) return true;
  return rule.allowedRoles.some((role) => role === "anonymous" || roles.includes(role));
}

const server = createServer(async (incoming, response) => {
  const url = new URL(incoming.url, `http://localhost:${port}`);
  const principal = PRINCIPALS[who];
  const roles = principal?.userRoles ?? ["anonymous"];

  const rule = routeRule(url.pathname);
  if (!allowed(rule, roles)) {
    response.writeHead(401, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "not allowed for this role (dev server)" }));
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    const found = match(incoming.method, url.pathname);
    if (!found) {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "unknown endpoint" }));
      return;
    }
    const headers = new Map();
    for (const [key, value] of Object.entries(incoming.headers)) headers.set(key, value);
    if (principal) {
      headers.set("x-ms-client-principal", Buffer.from(JSON.stringify(principal)).toString("base64"));
    }
    const body = await readBody(incoming);
    const request = {
      method: incoming.method,
      headers: { get: (name) => headers.get(String(name).toLowerCase()) },
      query: url.searchParams,
      params: found.params,
      text: async () => body,
    };
    let result;
    try {
      result = await found.handler(request, { store });
    } catch (error) {
      result = toResponse(error);
    }
    response.writeHead(result.status, result.headers ?? {});
    response.end(result.body ?? "");
    return;
  }

  await serveStatic(url.pathname, response);
});

function readBody(incoming) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    incoming.on("data", (chunk) => chunks.push(chunk));
    incoming.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
    incoming.on("error", reject);
  });
}

async function serveStatic(pathname, response) {
  let relative = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  if (relative.endsWith("/")) relative += "index.html";
  let filePath = join(ROOT, relative);
  if (!filePath.startsWith(ROOT)) {
    response.writeHead(403).end("forbidden");
    return;
  }
  try {
    const info = await stat(filePath);
    if (info.isDirectory()) filePath = join(filePath, "index.html");
  } catch {
    response.writeHead(404, { "Content-Type": "text/html" }).end("<h1>404</h1>");
    return;
  }
  response.writeHead(200, { "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream" });
  createReadStream(filePath).pipe(response);
}

server.listen(port, () => {
  console.log(`site   http://127.0.0.1:${port}/`);
  console.log(`admin  http://127.0.0.1:${port}/admin/`);
  console.log(`signed in as: ${who} (--as owner|money|anonymous)`);
});
