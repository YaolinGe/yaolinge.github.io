/**
 * Tiny HTTP helpers shared by every function.
 *
 * Handlers are written as plain `async (request) => response` functions taking
 * a small request shape, so the same code runs under the Azure Functions host
 * and under the local dev server in scripts/dev-server.mjs. Nothing in a
 * handler imports the Functions runtime.
 */

import { AuthError } from "./principal.js";
import { FieldError } from "./money.js";

export const MAX_BODY_BYTES = 512 * 1024; // generous for a blog post, small for a DoS

export function json(status, body) {
  return {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
    body: JSON.stringify(body),
  };
}

export function text(status, body, contentType = "text/plain; charset=utf-8") {
  return {
    status,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
    body,
  };
}

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/** Read and size-check a JSON body. */
export async function readJson(request) {
  let raw;
  try {
    raw = await request.text();
  } catch {
    throw new HttpError(400, "could not read the request body");
  }
  if (!raw) throw new HttpError(400, "request body is empty");
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    throw new HttpError(413, "request body is too large");
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, "request body is not valid JSON");
  }
}

/**
 * Turn any thrown error into a response. Known errors carry their own status
 * and are safe to show; anything else is logged and reported as a bare 500,
 * so an internal message never leaks to the browser.
 */
export function toResponse(error, log = console.error) {
  if (error instanceof FieldError) {
    return json(400, { error: error.message, field: error.field });
  }
  if (error instanceof AuthError) {
    return json(error.status, { error: error.message });
  }
  if (error instanceof HttpError) {
    return json(error.status, { error: error.message, ...error.extra });
  }
  log("unhandled error", error);
  return json(500, { error: "something went wrong" });
}

/** Wrap a handler so it can only ever resolve to a response. */
export function guard(handler) {
  return async (request, context) => {
    try {
      return await handler(request, context);
    } catch (error) {
      return toResponse(error, context?.error ?? console.error);
    }
  };
}
