#!/usr/bin/env node
/**
 * Load the existing blogs/*.html files into the database, once.
 *
 *   STORAGE_CONNECTION_STRING="..." node scripts/import-posts.mjs --dry-run
 *   STORAGE_CONNECTION_STRING="..." node scripts/import-posts.mjs
 *
 * Each imported post keeps `legacyPath`, so posts.html keeps linking to the
 * original static file and no URL that exists today changes. The body is
 * stored as the HTML that is already there rather than being converted to
 * Markdown - a lossy round trip through a converter is not worth it for posts
 * that are already written. Editing one in the admin replaces it with
 * Markdown from then on.
 */

import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createStore } from "../api/src/lib/tables.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dryRun = process.argv.includes("--dry-run");

function extract(html, filename) {
  // The <title> tag holds the short name posts.html has always listed; the
  // <h1> inside the article is a longer sentence that belongs to the post
  // itself. Keep both: the short one as the title, the long one as the first
  // line of the body, so no wording is lost and the list reads as it does now.
  const shortTitle = html.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim();
  const heading = html
    .match(/<article class="blog-post">[\s\S]*?<h1>([\s\S]*?)<\/h1>/)?.[1]
    ?.trim();
  const date =
    html.match(/<div class="date">\s*([0-9]{4}-[0-9]{2}-[0-9]{2})\s*<\/div>/)?.[1] ??
    filename.match(/^(\d{4})-(\d{2})-(\d{2})/)?.slice(1).join("-") ??
    "";
  const body =
    html.match(/<div id="content">([\s\S]*?)<\/div>\s*<\/article>/)?.[1] ??
    html.match(/<article class="blog-post">([\s\S]*?)<\/article>/)?.[1] ??
    "";

  const title = decode(shortTitle || heading || filename);
  const keepHeading = heading && decode(heading) !== title;
  return {
    title,
    date,
    html: `${keepHeading ? `<h2>${heading}</h2>\n` : ""}${body.trim()}`,
  };
}

function decode(text) {
  return text
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function summarise(html, maxLength = 200) {
  const plain = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return plain.length > maxLength ? `${plain.slice(0, maxLength - 1).trimEnd()}...` : plain;
}

const files = (await readdir(join(ROOT, "blogs"))).filter((name) => name.endsWith(".html")).sort();
const store = dryRun ? null : createStore();
let imported = 0;
const problems = [];

for (const filename of files) {
  const raw = await readFile(join(ROOT, "blogs", filename), "utf8");
  const post = extract(raw, filename);
  const slug = filename.replace(/\.html$/, "").toLowerCase();
  if (!post.title || !post.date || !post.html) {
    problems.push(`${filename}: missing ${!post.title ? "title" : !post.date ? "date" : "body"}`);
    continue;
  }
  console.log(`${dryRun ? "would import" : "importing"}  ${post.date}  ${slug}  ${post.title}`);
  if (!dryRun) {
    await store.posts.save({
      slug,
      title: post.title,
      date: post.date,
      status: "published",
      markdown: "",              // the original is HTML; editing replaces it
      html: post.html,
      summary: summarise(post.html),
      author: "import",
      legacyPath: `blogs/${filename}`,
    });
  }
  imported += 1;
}

console.log(`\n${dryRun ? "would import" : "imported"} ${imported} of ${files.length} posts`);
for (const problem of problems) console.log(`  skipped ${problem}`);
if (dryRun) console.log("\ndry run - nothing was written");
