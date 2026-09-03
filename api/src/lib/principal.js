/**
 * Who is calling.
 *
 * Azure Static Web Apps authenticates the user and passes the result to the
 * API in the `x-ms-client-principal` header: base64 JSON with the provider,
 * a stable user id, the display name, and the roles assigned through the
 * invite list. There is no password anywhere in this app.
 *
 * The route rules in staticwebapp.config.json already gate these endpoints,
 * but every handler checks again here. A route rule is configuration; this is
 * the thing that actually decides, and it is one file to audit.
 */

/** Anyone with this role may read and write the shared expense ledger. */
export const ROLE_MONEY = "money";
/** Blog writing, and the destructive money operations (import, delete). */
export const ROLE_OWNER = "owner";

export class AuthError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Parse the header. Returns null when there is no valid principal. */
export function readPrincipal(headers) {
  const raw = typeof headers?.get === "function"
    ? headers.get("x-ms-client-principal")
    : headers?.["x-ms-client-principal"];
  if (!raw) return null;
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  } catch {
    return null; // malformed header: treat as anonymous, never as trusted
  }
  if (!decoded || typeof decoded !== "object") return null;
  const roles = Array.isArray(decoded.userRoles) ? decoded.userRoles.map(String) : [];
  if (!decoded.userId || !roles.includes("authenticated")) return null;
  return {
    userId: String(decoded.userId),
    userDetails: String(decoded.userDetails ?? ""),
    identityProvider: String(decoded.identityProvider ?? ""),
    roles,
  };
}

/** The principal, or an AuthError. `roles` is an OR: any one of them will do. */
export function requireRole(headers, roles) {
  const principal = readPrincipal(headers);
  if (!principal) throw new AuthError(401, "sign in first");
  const wanted = Array.isArray(roles) ? roles : [roles];
  if (!wanted.some((role) => principal.roles.includes(role))) {
    throw new AuthError(403, `this needs the ${wanted.join(" or ")} role`);
  }
  return principal;
}

/** A short, stable label for "who wrote this row", stored with each record. */
export function authorLabel(principal) {
  return principal.userDetails || principal.userId;
}
