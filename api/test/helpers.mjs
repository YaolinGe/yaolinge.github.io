/**
 * Test support: a real Azurite table service, so the storage layer is
 * exercised against the actual Azure Tables protocol rather than a stub.
 *
 * Each test file gets its own port and table prefix, because `node --test`
 * runs files in separate processes.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const AZURITE = fileURLToPath(new URL("../node_modules/azurite/dist/src/table/main.js", import.meta.url));
const ACCOUNT = "devstoreaccount1";
const KEY = "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";

export function connectionStringFor(port) {
  return (
    `DefaultEndpointsProtocol=http;AccountName=${ACCOUNT};AccountKey=${KEY};` +
    `TableEndpoint=http://127.0.0.1:${port}/${ACCOUNT};`
  );
}

function waitForPort(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() > deadline) reject(new Error(`azurite did not start on :${port}`));
        else setTimeout(attempt, 150);
      });
    };
    attempt();
  });
}

/** Start Azurite's table service. Returns { connectionString, stop }. */
export async function startAzurite(port) {
  const location = await mkdtemp(join(tmpdir(), "azurite-"));
  const child = spawn(
    process.execPath,
    [AZURITE, "--silent", "--location", location, "--tablePort", String(port), "--tableHost", "127.0.0.1"],
    { stdio: "ignore" }
  );
  child.unref();
  await waitForPort(port);
  return {
    connectionString: connectionStringFor(port),
    async stop() {
      child.kill();
      await rm(location, { recursive: true, force: true });
    },
  };
}

const encode = (object) => Buffer.from(JSON.stringify(object)).toString("base64");

export const PRINCIPALS = {
  owner: encode({
    userId: "u-yao", userDetails: "yao", identityProvider: "github",
    userRoles: ["anonymous", "authenticated", "owner", "money"],
  }),
  money: encode({
    userId: "u-partner", userDetails: "partner", identityProvider: "github",
    userRoles: ["anonymous", "authenticated", "money"],
  }),
  strangerSignedIn: encode({
    userId: "u-nobody", userDetails: "nobody", identityProvider: "github",
    userRoles: ["anonymous", "authenticated"],
  }),
};

/** Build the request shape the handlers expect. */
export function request({ method = "GET", as, params = {}, query = {}, body } = {}) {
  const headers = new Map();
  if (as) headers.set("x-ms-client-principal", PRINCIPALS[as] ?? as);
  return {
    method,
    headers: { get: (name) => headers.get(String(name).toLowerCase()) },
    query: new URLSearchParams(query),
    params,
    text: async () => (body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body)),
  };
}

export const parse = (response) => JSON.parse(response.body);
