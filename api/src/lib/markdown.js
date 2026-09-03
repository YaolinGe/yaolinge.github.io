/**
 * A small Markdown renderer.
 *
 * Posts are written as Markdown in the admin and rendered to HTML once, when
 * they are saved, so the public page only ever injects HTML this file produced.
 * Everything from the author is escaped before any tag is added, and link
 * targets are restricted to http(s), site-relative and fragment URLs - a
 * `javascript:` href is rendered as plain text rather than a link.
 *
 * The subset is deliberately the one the existing posts use: headings, lists,
 * tables, fenced code, blockquotes, rules, images, links, bold, italic,
 * inline code and strikethrough.
 */

const SAFE_HREF = /^(https?:\/\/|\/|#|mailto:)/i;
// A private-use character cannot appear in escaped output, so it is a safe
// stand-in while the rest of the inline markup is processed.
const MARK = "";
const MARK_PATTERN = new RegExp("\\uE000CODE(\\d+)\\uE000", "g");

export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeUrl(url) {
  const trimmed = String(url).trim();
  // Reject anything with a scheme we did not allow, including javascript: and
  // data:. A bare relative path such as assets/x.png has no colon at all.
  if (SAFE_HREF.test(trimmed)) return trimmed;
  if (!trimmed.includes(":")) return trimmed;
  return null;
}

/** Inline formatting for one already-block-parsed chunk of text. */
export function renderInline(source) {
  const codeSpans = [];
  // Pull code spans out first so their contents are never treated as markup.
  let text = String(source).replace(/`([^`]+)`/g, (_, code) => {
    codeSpans.push(code);
    return `${MARK}CODE${codeSpans.length - 1}${MARK}`;
  });

  text = escapeHtml(text);

  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (match, alt, url, title) => {
    const href = safeUrl(unescapeHtml(url));
    if (!href) return match;
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
    return `<img src="${escapeHtml(href)}" alt="${alt}"${titleAttr}>`;
  });

  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (match, label, url, title) => {
    const href = safeUrl(unescapeHtml(url));
    if (!href) return match;
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
    return `<a href="${escapeHtml(href)}"${titleAttr}>${label}</a>`;
  });

  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  text = text.replace(/~~([^~]+)~~/g, "<del>$1</del>");

  return text.replace(MARK_PATTERN, (_, index) => `<code>${escapeHtml(codeSpans[Number(index)])}</code>`);
}

function unescapeHtml(text) {
  return String(text)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function renderTable(rows) {
  const cells = (line) =>
    line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((cell) => cell.trim());
  const head = cells(rows[0]);
  const body = rows.slice(2).map(cells);
  const headHtml = head.map((cell) => `<th>${renderInline(cell)}</th>`).join("");
  const bodyHtml = body
    .map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join("")}</tr>`)
    .join("\n");
  return `<table>\n<thead>\n<tr>${headHtml}</tr>\n</thead>\n<tbody>\n${bodyHtml}\n</tbody>\n</table>`;
}

const TABLE_DIVIDER = /^\s*\|?[\s:-]*-[\s|:-]*$/;

/** Markdown -> HTML. */
export function renderMarkdown(source) {
  const lines = String(source ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let index = 0;

  const paragraph = [];
  const flushParagraph = () => {
    if (paragraph.length) out.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
    paragraph.length = 0;
  };

  while (index < lines.length) {
    const line = lines[index];

    const fence = line.match(/^```\s*([\w+-]*)\s*$/);
    if (fence) {
      flushParagraph();
      const language = fence[1];
      const code = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      index += 1; // closing fence
      const classAttr = language ? ` class="language-${escapeHtml(language)}"` : "";
      out.push(`<pre><code${classAttr}>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      index += 1;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^(\s*[-*_]){3,}\s*$/.test(line) && !/\w/.test(line)) {
      flushParagraph();
      out.push("<hr>");
      index += 1;
      continue;
    }

    // Table: a header row followed by a |---|---| divider
    if (line.includes("|") && index + 1 < lines.length && TABLE_DIVIDER.test(lines[index + 1])) {
      flushParagraph();
      const rows = [];
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        rows.push(lines[index]);
        index += 1;
      }
      out.push(renderTable(rows));
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      flushParagraph();
      const quoted = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quoted.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      out.push(`<blockquote>\n${renderMarkdown(quoted.join("\n"))}\n</blockquote>`);
      continue;
    }

    const bullet = line.match(/^\s*([-*+])\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || numbered) {
      flushParagraph();
      const ordered = Boolean(numbered);
      const items = [];
      while (index < lines.length) {
        const current = lines[index];
        const asBullet = current.match(/^\s*([-*+])\s+(.*)$/);
        const asNumber = current.match(/^\s*\d+[.)]\s+(.*)$/);
        if (ordered && asNumber) items.push(asNumber[1]);
        else if (!ordered && asBullet) items.push(asBullet[2]);
        else if (items.length && /^\s+\S/.test(current)) items[items.length - 1] += ` ${current.trim()}`;
        else break;
        index += 1;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>\n${items.map((item) => `<li>${renderInline(item)}</li>`).join("\n")}\n</${tag}>`);
      continue;
    }

    paragraph.push(line.trim());
    index += 1;
  }
  flushParagraph();
  return out.join("\n");
}

/** First paragraph, flattened, for the post list. */
export function summarise(source, maxLength = 200) {
  const plain = String(source ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")     // images carry nothing to read
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")   // links keep their label
    .replace(/^\s*\|.*$/gm, " ")                // table rows do not summarise
    .replace(/^\s*[#>]+\s*/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // Leave room for the ellipsis, so maxLength really is the maximum.
  return plain.length > maxLength ? `${plain.slice(0, maxLength - 3).trimEnd()}...` : plain;
}
