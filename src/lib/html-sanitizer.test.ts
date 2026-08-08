/*
 * HTML sanitizer tests. Migration 042.
 *
 * These are the tests that matter most in this feature. Everything
 * else in the post-purchase instructions path decides WHO may read
 * the content; this file decides whether the content is safe to
 * render at all, and it is the only thing standing between an
 * admin-authored rich-text field and script execution in a
 * client's browser.
 *
 * Written against the exported policy rather than against
 * sanitize-html itself, so the assertions describe MakeHijrah's
 * allowlist and would survive a change of library.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_RAW_HTML_LENGTH,
  MAX_SANITIZED_HTML_LENGTH,
  sanitizeRichText,
} from "./html-sanitizer.js";

describe("HTML sanitizer: allowed formatting", () => {
  it("keeps every allowed tag", () => {
    const input =
      "<p>para</p><h2>two</h2><h3>three</h3>" +
      "<strong>s</strong><b>b</b><em>e</em><i>i</i><u>u</u>" +
      "<ul><li>bullet</li></ul><ol><li>number</li></ol><br>";

    const output = sanitizeRichText(input)!;

    for (const tag of [
      "p",
      "h2",
      "h3",
      "strong",
      "b",
      "em",
      "i",
      "u",
      "ul",
      "ol",
      "li",
    ]) {
      assert.ok(
        output.includes(`<${tag}>`),
        `<${tag}> must survive sanitization`,
      );
    }

    assert.match(output, /<br\s*\/?>/);
    assert.ok(output.includes("bullet"));
    assert.ok(output.includes("number"));
  });

  it("keeps an http, https or mailto link with its href and title", () => {
    for (const href of [
      "https://example.test/onboarding",
      "http://example.test/onboarding",
      "mailto:support@example.test",
    ]) {
      const output = sanitizeRichText(
        `<a href="${href}" title="Start here">Start</a>`,
      )!;

      assert.ok(
        output.includes(`href="${href}"`),
        `${href} must survive`,
      );
      assert.ok(output.includes('title="Start here"'));
      assert.ok(output.includes("Start</a>"));
    }
  });

  it("preserves plain text and entities", () => {
    const output = sanitizeRichText(
      "<p>Fees &amp; charges &lt;important&gt;</p>",
    )!;

    assert.ok(output.includes("Fees &amp; charges"));
    assert.ok(output.includes("&lt;important&gt;"));
  });
});

describe("HTML sanitizer: dangerous content", () => {
  it("removes a script tag and its contents", () => {
    const output = sanitizeRichText(
      "<p>before</p><script>alert(1)</script><p>after</p>",
    )!;

    assert.ok(!/script/i.test(output));
    assert.ok(
      !output.includes("alert"),
      "the script body must be discarded, not escaped into visible text",
    );
    assert.ok(output.includes("before"));
    assert.ok(output.includes("after"));
  });

  it("removes event handler attributes", () => {
    for (const handler of [
      '<p onclick="alert(1)">text</p>',
      '<a href="https://ok.test" onmouseover="alert(1)">text</a>',
      '<strong onerror="alert(1)">text</strong>',
      '<p ONCLICK="alert(1)">text</p>',
    ]) {
      const output = sanitizeRichText(handler)!;

      assert.ok(
        !/on[a-z]+\s*=/i.test(output),
        `an event handler survived: ${output}`,
      );
      assert.ok(output.includes("text"));
    }
  });

  it("removes a javascript: href but keeps the link text", () => {
    for (const href of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "  javascript:alert(1)",
      "java\tscript:alert(1)",
    ]) {
      const output = sanitizeRichText(
        `<a href="${href}">click</a>`,
      )!;

      assert.ok(
        !/javascript/i.test(output),
        `a javascript href survived: ${output}`,
      );
      assert.ok(output.includes("click"));
    }
  });

  it("removes a data: href", () => {
    const output = sanitizeRichText(
      '<a href="data:text/html;base64,PHNjcmlwdD4=">click</a>',
    )!;

    assert.ok(!/data:/i.test(output));
    assert.ok(output.includes("click"));
  });

  it("removes vbscript: and protocol-relative hrefs", () => {
    const vbscript = sanitizeRichText(
      '<a href="vbscript:msgbox(1)">click</a>',
    )!;
    assert.ok(!/vbscript/i.test(vbscript));

    const relative = sanitizeRichText(
      '<a href="//evil.test/payload">click</a>',
    )!;
    assert.ok(
      !relative.includes("evil.test"),
      "a protocol-relative URL is not a destination we can vouch for",
    );
  });

  it("removes iframe, object, embed, form and style", () => {
    const output = sanitizeRichText(
      "<p>keep</p>" +
        '<iframe src="https://evil.test"></iframe>' +
        "<object data='x'></object>" +
        "<embed src='x'>" +
        "<form action='https://evil.test'><input name='a'></form>" +
        "<style>body{display:none}</style>",
    )!;

    for (const tag of [
      "iframe",
      "object",
      "embed",
      "form",
      "input",
      "style",
    ]) {
      assert.ok(
        !new RegExp(`<${tag}`, "i").test(output),
        `<${tag}> survived: ${output}`,
      );
    }

    assert.ok(output.includes("keep"));
    assert.ok(
      !output.includes("evil.test"),
      "no attribute of a discarded tag may leak through",
    );
  });

  it("strips arbitrary attributes from allowed tags", () => {
    const output = sanitizeRichText(
      '<p class="x" id="y" style="color:red" data-z="1">text</p>',
    )!;

    assert.equal(output, "<p>text</p>");
  });

  it("does not admit an image or its src", () => {
    const output = sanitizeRichText(
      '<p>a</p><img src="https://tracker.test/pixel.gif" onerror="alert(1)">',
    )!;

    assert.ok(!/<img/i.test(output));
    assert.ok(!output.includes("tracker.test"));
  });
});

describe("HTML sanitizer: link hardening", () => {
  it("forces rel and target on every surviving link", () => {
    const output = sanitizeRichText(
      '<a href="https://example.test">go</a>',
    )!;

    assert.ok(
      output.includes(
        'rel="noopener noreferrer nofollow"',
      ),
    );
    assert.ok(output.includes('target="_blank"'));
  });

  it("overwrites an author-supplied rel or target", () => {
    const output = sanitizeRichText(
      '<a href="https://example.test" rel="" target="_self">go</a>',
    )!;

    assert.ok(
      output.includes(
        'rel="noopener noreferrer nofollow"',
      ),
      "an author must not be able to opt out of link hardening",
    );
    assert.ok(output.includes('target="_blank"'));
    assert.ok(!output.includes('target="_self"'));
  });
});

describe("HTML sanitizer: robustness", () => {
  it("safely sanitizes malformed HTML", () => {
    for (const input of [
      "<p>unclosed <strong>bold",
      "<<p>>text<</p>>",
      '<p><a href="https://ok.test">nested <p>block</p></a></p>',
      "<script<script>>alert(1)</script>",
      '<p title="unterminated>text</p>',
      "</p></div></span>text",
    ]) {
      const output = sanitizeRichText(input);

      assert.ok(
        output === null ||
          !/<script|onerror|onclick|javascript:/i.test(
            output,
          ),
        `malformed input produced unsafe output: ${output}`,
      );
    }
  });

  it("is idempotent", () => {
    const inputs = [
      '<p>Hello <strong>world</strong> <a href="https://a.test">link</a></p>',
      "<ul><li>one</li><li>two</li></ul>",
      '<h2>Heading</h2><p>Body with <a href="mailto:a@b.test">mail</a>.</p>',
    ];

    for (const input of inputs) {
      const once = sanitizeRichText(input)!;
      const twice = sanitizeRichText(once)!;

      assert.equal(
        twice,
        once,
        "sanitizing twice must not change the value; the read path re-sanitizes what the write path stored",
      );
    }
  });

  it("returns null for anything with no readable content", () => {
    for (const input of [
      null,
      undefined,
      "",
      "   ",
      "<script>alert(1)</script>",
      "<iframe src='https://evil.test'></iframe>",
      "<p></p>",
      "<p>   </p>",
      "<style>body{}</style>",
    ]) {
      assert.equal(
        sanitizeRichText(input),
        null,
        `expected null for ${JSON.stringify(input)}`,
      );
    }
  });

  it("keeps content that is only text", () => {
    assert.equal(
      sanitizeRichText("just words"),
      "just words",
    );
  });

  it("exposes bounds with the raw limit above the stored limit", () => {
    assert.ok(
      MAX_RAW_HTML_LENGTH > MAX_SANITIZED_HTML_LENGTH,
      "sanitizing shrinks input, so the pre-sanitization bound must be the larger of the two",
    );
    assert.equal(MAX_SANITIZED_HTML_LENGTH, 20_000);
    assert.equal(MAX_RAW_HTML_LENGTH, 50_000);
  });

  it("handles a large document without pathological behaviour", () => {
    const large =
      "<p>paragraph</p>".repeat(2_000) +
      "<script>alert(1)</script>";

    const output = sanitizeRichText(large)!;

    assert.ok(!/script/i.test(output));
    assert.ok(output.includes("paragraph"));
  });
});
