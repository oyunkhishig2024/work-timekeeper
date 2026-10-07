export interface ParsedConsentText {
  title: string;
  paragraphs: string[];
}

/**
 * A consent text is plain text: the first line is the title, every other non-empty line is a paragraph.
 * Lines starting with "#" are comments (used in the files under docs/consent) and are ignored.
 */
export function parseConsentText(body: string): ParsedConsentText {
  const lines = body
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  const [title = "", ...paragraphs] = lines;
  return { title, paragraphs };
}
