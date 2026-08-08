import sanitizeHtml from "sanitize-html";

/*
 * The single HTML allowlist for this system.
 *
 * One place, used by BOTH the admin write path and the client read
 * path, so the two can never disagree about what is safe. Nothing
 * in this file is hand-rolled: an allowlist parser written by hand
 * is one of the reliable ways to ship a cross-site scripting hole,
 * so the parsing is delegated to sanitize-html and this module
 * contributes only the policy.
 *
 * The policy is an ALLOWLIST throughout — tags, attributes and URL
 * schemes. That is the property that matters: something nobody
 * thought of is rejected by default rather than admitted by
 * default. A blocklist of `script`, `iframe` and friends would be
 * a list of the attacks we happened to remember.
 */

/*
 * Rich text, and nothing that executes, loads or positions.
 *
 * No `script`, `style`, `iframe`, `object`, `embed` or `form`, and
 * no way to reintroduce them: they are not on this list, and
 * disallowedTagsMode 'discard' removes them along with their
 * contents rather than escaping them into visible page text.
 */
const ALLOWED_TAGS = [
  "p",
  "br",
  "strong",
  "em",
  "b",
  "i",
  "u",
  "ul",
  "ol",
  "li",
  "h2",
  "h3",
  "a",
] as const;

/*
 * Attributes are allowlisted PER TAG and the global entry is
 * empty, so `onclick`, `onerror`, `style`, `srcdoc`, `formaction`
 * and every other event or behaviour attribute is dropped from
 * every element — including from the tags that are allowed.
 * `href` and `title` on an anchor are the entire attribute
 * surface of this system's rich text.
 */
const ALLOWED_ATTRIBUTES: Record<string, string[]> = {
  /*
   * rel and target are listed because transformTags below ADDS
   * them, and attribute filtering runs after the transform — an
   * attribute the transform forces on but the allowlist omits
   * would be stripped straight back off, quietly undoing the
   * link hardening. An author-supplied rel or target is
   * overwritten by the transform, so listing them here grants
   * the author nothing.
   */
  a: ["href", "title", "rel", "target"],
  "*": [],
};

/*
 * URL schemes, allowlisted. This is what rejects javascript:,
 * data:, vbscript:, file: and anything else — not by naming them,
 * but by admitting only these three. sanitize-html drops the
 * offending attribute rather than the element, so the link text
 * survives as plain text and the reader loses nothing but the
 * hostile destination.
 */
const ALLOWED_SCHEMES = ["http", "https", "mailto"] as const;

/*
 * Every surviving link is rewritten, not merely inspected.
 *
 * rel="noopener noreferrer nofollow" and target="_blank" are
 * FORCED rather than defaulted: an author-supplied rel is
 * overwritten, so a link cannot opt out of the protections.
 * noopener/noreferrer close the reverse-tabnabbing hole that
 * target="_blank" opens; nofollow keeps admin-authored delivery
 * links out of the platform's outbound link graph.
 */
const FORCED_LINK_ATTRIBUTES = {
  rel: "noopener noreferrer nofollow",
  target: "_blank",
};

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [...ALLOWED_TAGS],
  allowedAttributes: ALLOWED_ATTRIBUTES,
  allowedSchemes: [...ALLOWED_SCHEMES],
  /* Applies to href on <a>; the same allowlist, stated for the
     attribute rather than inherited, so a future attribute cannot
     quietly acquire a wider scheme set. */
  allowedSchemesByTag: {
    a: [...ALLOWED_SCHEMES],
  },
  /* A relative or scheme-less URL is not a delivery destination
     we can vouch for, so it is not admitted either. */
  allowProtocolRelative: false,
  /*
   * 'discard' rather than 'escape'. A disallowed tag and its
   * contents disappear; escaping would render the raw markup as
   * visible text, which turns an attack into a confusing page.
   */
  disallowedTagsMode: "discard",
  transformTags: {
    /*
     * merge = true. The forced attributes are written OVER the
     * author's, so an author-supplied rel="" or target="_self"
     * loses, while href and title — the two attributes the author
     * legitimately controls — survive. Replacing outright instead
     * would strip every href and turn every link into plain text.
     */
    a: sanitizeHtml.simpleTransform(
      "a",
      FORCED_LINK_ATTRIBUTES,
      true,
    ),
  },
};

/*
 * True when the sanitized HTML carries no readable content — the
 * input was markup only, or was entirely disallowed.
 *
 * Checked on the SANITIZED value, not the raw one, so
 * "<script>alert(1)</script>" and "   " reach the same conclusion:
 * there is nothing here to show a client. The caller stores null
 * for both, which keeps "cleared the field" and "wrote something
 * that sanitized away to nothing" as one state rather than two
 * that behave differently.
 */
const hasReadableContent = (html: string): boolean => {
  const withoutTags = html
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .trim();

  return withoutTags.length > 0;
};

/*
 * Sanitize admin-authored rich text.
 *
 * Returns null for null, undefined, blank input, and for input
 * that sanitizes away to nothing. Otherwise returns the sanitized
 * HTML.
 *
 * Deliberately idempotent: sanitizing an already-sanitized value
 * returns the same string, which is what lets the read path
 * sanitize again without corrupting content that was already
 * cleaned on write. That property is asserted by a test rather
 * than assumed.
 */
export const sanitizeRichText = (
  value: string | null | undefined,
): string | null => {
  if (value === null || value === undefined) {
    return null;
  }

  const trimmed = value.trim();

  if (trimmed === "") {
    return null;
  }

  const sanitized = sanitizeHtml(
    trimmed,
    SANITIZE_OPTIONS,
  ).trim();

  if (!hasReadableContent(sanitized)) {
    return null;
  }

  return sanitized;
};

/*
 * The stored bound, matching the CHECK constraint migration 042
 * puts on services.post_purchase_instructions_html.
 *
 * Applied to the SANITIZED value, so markup cannot be used to
 * smuggle a payload past the limit and so the application rejects
 * exactly what the database would.
 */
export const MAX_SANITIZED_HTML_LENGTH = 20_000;

/*
 * The pre-sanitization bound. Deliberately larger: sanitizing
 * shrinks input, so a legitimate document that ends up under
 * 20,000 characters may well arrive above it. This exists to stop
 * an enormous payload reaching the parser at all, not to police
 * content.
 */
export const MAX_RAW_HTML_LENGTH = 50_000;
