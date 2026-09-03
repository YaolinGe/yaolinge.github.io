import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderMarkdown, renderInline, summarise } from "../src/lib/markdown.js";

describe("rendering markdown", () => {
  it("does headings, emphasis, code and links", () => {
    assert.equal(renderMarkdown("# Title"), "<h1>Title</h1>");
    assert.equal(renderInline("**bold** and *em*"), "<strong>bold</strong> and <em>em</em>");
    assert.equal(renderInline("`a < b`"), "<code>a &lt; b</code>");
    assert.equal(renderInline("[x](https://a.b)"), '<a href="https://a.b">x</a>');
  });

  it("does lists", () => {
    assert.equal(renderMarkdown("- one\n- two"), "<ul>\n<li>one</li>\n<li>two</li>\n</ul>");
    assert.equal(renderMarkdown("1. one\n2. two"), "<ol>\n<li>one</li>\n<li>two</li>\n</ol>");
  });

  it("does tables, the way the existing posts use them", () => {
    const html = renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |");
    assert.match(html, /<table>/);
    assert.match(html, /<th>a<\/th><th>b<\/th>/);
    assert.match(html, /<td>1<\/td><td>2<\/td>/);
  });

  it("does fenced code without touching what is inside", () => {
    const html = renderMarkdown('```js\nif (a < b) x("y");\n```');
    assert.equal(html, '<pre><code class="language-js">if (a &lt; b) x(&quot;y&quot;);</code></pre>');
  });

  it("does blockquotes and rules", () => {
    assert.equal(renderMarkdown("> hello"), "<blockquote>\n<p>hello</p>\n</blockquote>");
    assert.equal(renderMarkdown("---"), "<hr>");
  });

  it("joins the lines of a paragraph", () => {
    assert.equal(renderMarkdown("one\ntwo\n\nthree"), "<p>one two</p>\n<p>three</p>");
  });

  it("handles an empty document", () => {
    assert.equal(renderMarkdown(""), "");
    assert.equal(renderMarkdown(null), "");
  });
});

describe("what the renderer refuses to emit", () => {
  it("escapes anything that looks like a tag", () => {
    assert.equal(
      renderMarkdown("<script>alert(1)</script>"),
      "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>"
    );
    assert.match(renderMarkdown("<img src=x onerror=alert(1)>"), /&lt;img/);
  });

  it("will not build a javascript: link", () => {
    assert.equal(renderInline("[x](javascript:alert(1))"), "[x](javascript:alert(1))");
    assert.equal(renderInline("[x](JaVaScRiPt:alert(1))"), "[x](JaVaScRiPt:alert(1))");
  });

  it("will not build a data: image", () => {
    assert.match(renderInline("![x](data:text/html;base64,PHN2Zz4=)"), /^!\[x\]/);
  });

  it("allows the URL shapes a post needs", () => {
    for (const url of ["https://a.b/c", "http://a.b", "/assets/img.png", "#section", "assets/x.png", "mailto:a@b.c"]) {
      assert.match(renderInline(`[x](${url})`), /^<a href=/, url);
    }
  });

  it("escapes a quote inside a link title", () => {
    const html = renderInline('[x](https://a.b "he said \\"hi\\"")');
    assert.doesNotMatch(html.replace(/&quot;/g, ""), /title="[^"]*"[^>]*"/);
  });
});

describe("summaries", () => {
  it("reads like the first sentence, not like markup", () => {
    const source = "# Title\n\nSome **bold** text and a [link](https://x.com) here.\n\n" +
      "| a | b |\n|---|---|\n\n```js\ncode();\n```\n\n![pic](/img.png)";
    assert.equal(summarise(source), "Title Some bold text and a link here.");
  });

  it("truncates politely", () => {
    const summary = summarise("word ".repeat(100));
    assert.ok(summary.length <= 200);
    assert.match(summary, /\.\.\.$/);
  });
});
