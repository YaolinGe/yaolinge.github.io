/**
 * Azure Table Storage: the only place data lives.
 *
 * Two tables, both tiny:
 *   expenses  PartitionKey "expense", RowKey a time-ordered id
 *   posts     PartitionKey "post",    RowKey the slug
 *
 * Two details Table Storage forces on us, handled here so no caller has to
 * think about them:
 *   - There is no decimal type. Amounts are stored as Edm.Int64 ore, as a
 *     string, and converted back to an integer on the way out. Nothing is ever
 *     a float.
 *   - A single property tops out at 64 KiB, which a long post can exceed, so
 *     post bodies are split across numbered properties and joined on read.
 */

import { TableClient, odata } from "@azure/data-tables";
import { HttpError } from "./http.js";

export const EXPENSE_PARTITION = "expense";
export const POST_PARTITION = "post";

const CHUNK_CHARS = 24000;      // comfortably under the 64 KiB property limit
const MAX_BODY_CHARS = 400000;  // ~1 MiB entity limit, with room for the rest

function chunkProperties(name, value) {
  const text = String(value ?? "");
  if (text.length > MAX_BODY_CHARS) {
    throw new HttpError(413, "that post is too long to store (400k characters max)");
  }
  const properties = { [`${name}Chunks`]: Math.ceil(text.length / CHUNK_CHARS) };
  for (let index = 0; index * CHUNK_CHARS < text.length; index += 1) {
    properties[`${name}${index}`] = text.slice(index * CHUNK_CHARS, (index + 1) * CHUNK_CHARS);
  }
  return properties;
}

function joinChunks(entity, name) {
  const count = Number(entity[`${name}Chunks`] ?? 0);
  let text = "";
  for (let index = 0; index < count; index += 1) text += entity[`${name}${index}`] ?? "";
  return text;
}

function toOre(value) {
  // Edm.Int64 comes back as { value: "52600", type: "Int64" }; a plain number
  // means the row was written by an older client.
  const raw = value && typeof value === "object" ? value.value : value;
  const ore = Number(raw);
  if (!Number.isSafeInteger(ore)) throw new HttpError(500, "a stored amount is not a whole number of ore");
  return ore;
}

function int64(ore) {
  return { value: String(ore), type: "Int64" };
}

/** A sortable id: newest rows sort last, so ascending order is chronological. */
export function newId(now = Date.now()) {
  const stamp = now.toString(36).padStart(9, "0");
  const random = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${random}`;
}

export function createStore(options = {}) {
  const connectionString =
    options.connectionString ?? process.env.STORAGE_CONNECTION_STRING ?? process.env.AzureWebJobsStorage;
  if (!connectionString) {
    throw new Error("STORAGE_CONNECTION_STRING is not set");
  }
  const prefix = options.prefix ?? process.env.TABLE_PREFIX ?? "";
  const clientOptions = { allowInsecureConnection: connectionString.includes("http://") };

  const expenseTable = TableClient.fromConnectionString(
    connectionString, `${prefix}expenses`, clientOptions
  );
  const postTable = TableClient.fromConnectionString(
    connectionString, `${prefix}posts`, clientOptions
  );

  let ready;
  async function ensure() {
    if (!ready) {
      ready = Promise.all([expenseTable.createTable(), postTable.createTable()]).catch((error) => {
        if (error?.statusCode === 409) return; // already there
        ready = undefined;
        throw error;
      });
    }
    return ready;
  }

  const expenseFromEntity = (entity) => ({
    id: entity.rowKey,
    date: entity.date,
    category: entity.category,
    type: entity.type,
    payer: entity.payer,
    amountOre: toOre(entity.amountOre),
    description: entity.description ?? "",
    createdBy: entity.createdBy ?? "",
    createdAt: entity.createdAt ?? "",
  });

  const postFromEntity = (entity, { withBody = true } = {}) => ({
    slug: entity.rowKey,
    title: entity.title,
    date: entity.date,
    status: entity.status,
    summary: entity.summary ?? "",
    author: entity.author ?? "",
    createdAt: entity.createdAt ?? "",
    updatedAt: entity.updatedAt ?? "",
    // Posts imported from the old static files keep their original URL.
    ...(entity.legacyPath ? { legacyPath: entity.legacyPath } : {}),
    ...(withBody ? { markdown: joinChunks(entity, "markdown"), html: joinChunks(entity, "html") } : {}),
  });

  return {
    ensure,

    expenses: {
      async list() {
        await ensure();
        const found = [];
        const query = expenseTable.listEntities({
          queryOptions: { filter: odata`PartitionKey eq ${EXPENSE_PARTITION}` },
        });
        for await (const entity of query) found.push(expenseFromEntity(entity));
        // Newest first: ids are time-ordered, dates are the user's own field.
        found.sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
        return found;
      },

      async add(expense, author) {
        await ensure();
        const id = newId();
        await expenseTable.createEntity({
          partitionKey: EXPENSE_PARTITION,
          rowKey: id,
          date: expense.date,
          category: expense.category,
          type: expense.type,
          payer: expense.payer,
          amountOre: int64(expense.amountOre),
          description: expense.description,
          createdBy: author,
          createdAt: new Date().toISOString(),
        });
        return { ...expense, id, createdBy: author };
      },

      async get(id) {
        await ensure();
        try {
          return expenseFromEntity(await expenseTable.getEntity(EXPENSE_PARTITION, id));
        } catch (error) {
          if (error?.statusCode === 404) return null;
          throw error;
        }
      },

      async remove(id) {
        await ensure();
        try {
          await expenseTable.deleteEntity(EXPENSE_PARTITION, id);
          return true;
        } catch (error) {
          if (error?.statusCode === 404) return false;
          throw error;
        }
      },
    },

    posts: {
      async list({ includeDrafts = false } = {}) {
        await ensure();
        const found = [];
        const query = postTable.listEntities({
          queryOptions: { filter: odata`PartitionKey eq ${POST_PARTITION}` },
        });
        for await (const entity of query) {
          if (!includeDrafts && entity.status !== "published") continue;
          found.push(postFromEntity(entity, { withBody: false }));
        }
        found.sort((a, b) => b.date.localeCompare(a.date));
        return found;
      },

      async get(slug) {
        await ensure();
        try {
          return postFromEntity(await postTable.getEntity(POST_PARTITION, slug));
        } catch (error) {
          if (error?.statusCode === 404) return null;
          throw error;
        }
      },

      async save(post) {
        await ensure();
        const now = new Date().toISOString();
        const existing = await this.get(post.slug);
        const entity = {
          partitionKey: POST_PARTITION,
          rowKey: post.slug,
          title: post.title,
          date: post.date,
          status: post.status,
          summary: post.summary,
          author: post.author,
          createdAt: existing?.createdAt || now,
          updatedAt: now,
          // Editing an imported post must not lose where it is served from.
          ...(post.legacyPath ?? existing?.legacyPath
            ? { legacyPath: post.legacyPath ?? existing.legacyPath }
            : {}),
          ...chunkProperties("markdown", post.markdown),
          ...chunkProperties("html", post.html),
        };
        // Replace rather than merge: a shorter body must not leave stale chunks.
        await postTable.upsertEntity(entity, "Replace");
        return { ...post, createdAt: entity.createdAt, updatedAt: now };
      },

      async remove(slug) {
        await ensure();
        try {
          await postTable.deleteEntity(POST_PARTITION, slug);
          return true;
        } catch (error) {
          if (error?.statusCode === 404) return false;
          throw error;
        }
      },
    },
  };
}
