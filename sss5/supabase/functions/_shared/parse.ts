// Parses Claude's labeled-field output (LABEL:\n value...\n\n LABEL:...) into
// a flat string-map. Both the chapter-1 and chapter-N+ prompts use the same
// shape, so this works for both.
//
// Tolerates:
//   - extra blank lines
//   - the failsafe "STATUS: ERROR / ERROR_REASON: FORMAT_FAILURE" response
//   - mixed-case labels, but normalizes to UPPER_SNAKE in the returned map

const LABEL_RE = /^([A-Z][A-Z0-9_]*):\s*$/;

export interface ParseResult {
  ok: boolean;
  fields: Record<string, string>;
  errorReason?: string;
}

export function parseLabeled(raw: string): ParseResult {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const fields: Record<string, string> = {};
  let currentKey: string | null = null;
  let buffer: string[] = [];

  const flush = () => {
    if (currentKey) {
      fields[currentKey] = buffer.join("\n").trim();
    }
    buffer = [];
  };

  for (const line of lines) {
    // Match "STATUS: ERROR" / "ERROR_REASON: FORMAT_FAILURE" inline labels too
    const inlineLabel = line.match(/^([A-Z][A-Z0-9_]*):\s*(.*)$/);
    const blockLabel  = line.match(LABEL_RE);

    if (blockLabel) {
      // start of new field, value follows on subsequent lines
      flush();
      currentKey = blockLabel[1];
    } else if (inlineLabel && inlineLabel[2].length > 0 && currentKey === null) {
      // first line of the response is something like "STATUS: ERROR"
      fields[inlineLabel[1]] = inlineLabel[2].trim();
    } else if (inlineLabel && inlineLabel[2].length > 0 && currentKey !== null
               && /^(STATUS|ERROR_REASON)$/.test(inlineLabel[1])) {
      // failsafe markers can appear inline mid-response
      flush();
      fields[inlineLabel[1]] = inlineLabel[2].trim();
      currentKey = null;
    } else {
      buffer.push(line);
    }
  }
  flush();

  if (fields.STATUS === "ERROR") {
    return {
      ok: false,
      fields,
      errorReason: fields.ERROR_REASON ?? "FORMAT_FAILURE",
    };
  }

  return { ok: Object.keys(fields).length > 0, fields };
}
