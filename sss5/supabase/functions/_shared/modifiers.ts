// Per-option modifier chips (IDEA #3, "Shape this option").
// Shared helpers used by BOTH generate-chapter (V1) and generate-chapter-v2.
//
// The model produces `NEXT_OPTIONS_1_MODIFIERS`, `_2_MODIFIERS`, `_3_MODIFIERS`
// sections in its output. We parse those into arrays, optionally filter them
// against per-story hard limits, then persist as
// { "1": [...], "2": [...], "3": [...] } into chapters.next_options_modifiers.
//
// The frontend reads that JSONB and renders checkbox chips under each option.
// See CHAPTER_TUNING_PLAN.md.

/**
 * Parse a single NEXT_OPTIONS_N_MODIFIERS text block into an array.
 * Handles bullets, numbering, trailing punctuation, empty lines. Caps at 6.
 */
export function parseModifierBlock(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(/\n+/)
    .map((line) => line.trim()
      .replace(/^[-*•]\s*/, "")            // strip leading bullets
      .replace(/^\d+[\.\):-]\s*/, "")       // strip leading numbering
      .replace(/[\s.,;:]+$/, "")            // strip trailing punctuation
      .trim()
    )
    .filter((s) => s.length >= 3 && s.length <= 80)
    .slice(0, 6);
}

/**
 * Filter object shape. Callers pass whatever they can derive from their
 * quiz version. V2 uses resolveQ9Filters(); V1 currently passes an empty
 * object (no hard-limit filter for legacy stories).
 */
export interface ModifierFilters {
  ban_kink?: boolean;
  ban_dark?: boolean;
  ban_multi_partner?: boolean;
  ban_voyeur?: boolean;
  enforce_enthusiastic_consent?: boolean;
  free_text_skips?: string;
}

// Keyword blacklists keyed off the filter flags. Best-effort — the prompt
// already tells the model to respect hard limits; this is defense in depth
// for the checkbox-visible modifier chips. Case-insensitive substring.
const FILTER_KEYWORDS = {
  ban_kink:          ["bondage", "bound", "restraint", "restrained", "tied", "wrists held", "wrists above", "handcuff", "collar", "leash", "spank", "flog", "gag", "whip", "impact", "praise-kink", "praise kink", "begging"],
  ban_dark:          ["threat", "captor", "captive", "kidnap", "stalker", "mafia", "villain", "possessive", "possession"],
  ban_multi_partner: ["two men", "two women", "third", "another partner", "watching them", "watching us", "join", "threesome", "group"],
  ban_voyeur:        ["voyeur", "watch", "watching", "audience", "public sex", "in front of", "mirror"],
  cnc:               ["force", "forced", "no-safe-word", "cnc", "dubcon", "consensual-non-consent"],
};

/**
 * Drop modifiers that contain any banned keyword derived from filters.
 * Passes through unchanged when filters is empty (V1 use).
 */
export function filterModifiersAgainstLimits(
  modifiers: string[],
  filters: ModifierFilters,
): string[] {
  const banned: string[] = [];
  if (filters.ban_kink)                     banned.push(...FILTER_KEYWORDS.ban_kink);
  if (filters.ban_dark)                     banned.push(...FILTER_KEYWORDS.ban_dark);
  if (filters.ban_multi_partner)            banned.push(...FILTER_KEYWORDS.ban_multi_partner);
  if (filters.ban_voyeur)                   banned.push(...FILTER_KEYWORDS.ban_voyeur);
  if (filters.enforce_enthusiastic_consent) banned.push(...FILTER_KEYWORDS.cnc);
  // free_text_skips → tokenized substring check
  const freeTokens = (filters.free_text_skips ?? "")
    .toLowerCase()
    .split(/[\s,;.\n]+/)
    .filter((t) => t.length >= 4);
  banned.push(...freeTokens);

  if (banned.length === 0) return modifiers;   // fast path

  return modifiers.filter((m) => {
    const lower = m.toLowerCase();
    return !banned.some((k) => lower.includes(k.toLowerCase()));
  });
}

/**
 * Build the {"1":[...],"2":[...],"3":[...]} JSONB payload for the chapters
 * row from a parsed labeled-output field map. Returns null when all three
 * lists end up empty (frontend renders no checkboxes at all — clean
 * fallback). Also drops lists with <2 items — a lone checkbox is uglier
 * than none.
 */
export function buildNextOptionsModifiersJson(
  rawFields: Record<string, string>,
  filters: ModifierFilters,
): { [k: string]: string[] } | null {
  const out: { [k: string]: string[] } = {};
  for (const n of [1, 2, 3]) {
    const raw = rawFields[`NEXT_OPTIONS_${n}_MODIFIERS`];
    const parsed = parseModifierBlock(raw);
    const filtered = filterModifiersAgainstLimits(parsed, filters);
    if (filtered.length >= 2) out[String(n)] = filtered;
  }
  return Object.keys(out).length ? out : null;
}
