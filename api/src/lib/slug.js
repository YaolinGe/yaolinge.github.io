/** Post slugs: what ends up in the URL, so keep them boring. */

const NORDIC = { "æ": "ae", "ø": "o", "å": "a", "ä": "a", "ö": "o", "ü": "u", "é": "e", "è": "e" };

export function slugify(input) {
  return String(input ?? "")
    .toLowerCase()
    .replace(/[æøåäöüéè]/g, (character) => NORDIC[character] ?? character)
    .normalize("NFD")
    .replace(new RegExp("[\\u0300-\\u036f]", "g"), "")   // drop combining marks
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
}

export function isValidSlug(slug) {
  return /^[a-z0-9][a-z0-9-]{0,79}$/.test(String(slug ?? ""));
}
