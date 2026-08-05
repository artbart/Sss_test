// V2 chapter prompts — built for the V6 quiz spec (see quiz_draft_v6.html).
//
// Two entry points, mirrors of V1:
//   - chapter1PromptV2  → chapter 1 (full setup, produces story metadata + first chapter)
//   - chapterNPromptV2  → chapter 2..10 (continuation using story state + user choice)
//
// Design principles (see SSS_V2_PLAN.md for full rationale):
//   1. V2 output format is IDENTICAL to V1 (same labeled fields) so the DB rows are
//      compatible and stories.html renders both without version awareness.
//   2. POV depends on q1_in_story: 'yes' = second person + reader's name/gender;
//      'no' (default) = third person about invented characters.
//   3. Q9 (skip) is a HARDCODED FIRST-PASS FILTER — any mood/specific/drill answer
//      that conflicts with Q9 is dropped before the prompt is built. Q9 wins.
//   4. Mood chips expand into internal parameter bundles (see MOOD_CHIP_BUNDLES).
//   5. Drills only apply when q8b_setup_depth === 'full'.
//
// This file is dormant until generate-chapter-v2 imports and calls it.

import type { VarietyContext } from "./variety.ts";

// ═══════════════════════════════════════════════════════════════════════════════
// Types — mirror the quiz2_sessions schema
// ═══════════════════════════════════════════════════════════════════════════════

export interface Quiz2Context {
  q0_age_confirmed?: boolean;
  q1_in_story?: "no" | "yes";
  q1b_you?: { name?: string; gender?: "woman" | "man" | "nb" } | null;
  q2_pairing?: "wm" | "ww" | "mm" | "queer" | "surprise";
  q3_world?: "contemporary" | "historical" | "fantasy_paranormal" | "monster" | "omegaverse" | "surprise";
  q4_love_interest?: "brooding" | "protective" | "playful" | "ruthless" | "wounded" | "cinnamon" | "wildcard" | "surprise";
  q5_opening?: "slow_build" | "meet_cute" | "already_ten" | "one_night" | "forced" | "fresh_start" | "surprise";
  q6_spicy?: "sweet" | "spicy" | "very_spicy";
  q7_mood?: string[];
  q8_specifics?: string[];
  q8b_setup_depth?: "quick" | "full" | null;
  q9_skip?: { open_any?: boolean; specifics?: string[]; free_text?: string } | null;

  // Drills — only populated when q8b_setup_depth = 'full'
  d_restraint?: "held" | "light" | "real" | "full" | null;
  d_sensory?: string[];
  d_talk?: string[];
  d_aftercare?: "warm" | "fed" | "quiet" | "playful" | "fade" | null;
  d_paranormal_kind?: string[];
  d_monster_flavor?: string[];
  d_omegaverse?: string[];
  d_size?: "massive" | "significant" | "present" | "skip" | null;
  d_partner_dynamic?: "mutual" | "centered" | "two_plus_one" | "hierarchical" | "decide" | null;
  d_dark_kind?: "mafia" | "villain" | "stalker" | "captor" | "gray" | "full_villain" | null;
  d_dark_consent?: "fully" | "dubcon" | "cnc" | "skip" | null;
  d_voyeur?: "watched" | "watching" | "mutual" | "someone_else" | "risk_only" | null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════════

const FAILSAFE_BLOCK = `FORMAT COMPLIANCE:

- Always use the exact labeled format below.
- Every listed field must appear, with real content underneath the label.
- No prose commentary outside the labeled fields — no preamble, no closing note, no markdown, no code fences.
- If a specific requested element feels awkward, write around it and keep going. Do NOT abandon the chapter over a single element.
- Only reserve the following failure response for cases where you literally cannot emit the labeled structure at all (e.g. a hard technical error):

  STATUS: ERROR
  ERROR_REASON: FORMAT_FAILURE

- Do not use the failure response to signal content discomfort. If a scene feels heavy, soften language or angle differently, but continue the chapter.`;

// Human-readable descriptions for each pairing option (goes into prompt as directive)
const PAIRING_DESCRIPTIONS: Record<string, string> = {
  wm: "a woman and a man (straight romance)",
  ww: "two women (F/F sapphic romance)",
  mm: "two men (M/M romance)",
  queer: "a queer romance — flexible gender configuration, could be a pair or small group with mixed genders",
  surprise: "let the story pick — prefer a well-crafted M/F, F/F, or M/M depending on world fit",
};

const WORLD_DESCRIPTIONS: Record<string, string> = {
  contemporary: "contemporary — real-world present day, everyday professions, no supernatural elements",
  historical: "historical (regency or period) — pre-modern setting with class, propriety, and old-world atmosphere",
  fantasy_paranormal: "fantasy or paranormal — magic system, supernatural beings, or myth-informed world",
  monster: "monster / non-human romance — the love interest is an intelligent non-human being (never actual animals)",
  omegaverse: "omegaverse — alpha/beta/omega dynamics, heat cycles, mating bonds, scent-driven",
  surprise: "let the story pick a fitting world",
};

const LOVE_INTEREST_ARCHETYPES: Record<string, string> = {
  brooding: "brooding & mysterious — walls up, layers revealed slowly, quiet intensity",
  protective: "protective & steady — older, grounded, provider energy, quietly unshakeable",
  playful: "playful & bright — flirt, disarms with humor, easy warmth",
  ruthless: "ruthless & controlled — powerful, precise, dangerous, moves deliberately",
  wounded: "wounded & guarded — carries a specific hurt, softens only for the protagonist",
  cinnamon: "cinnamon roll — sweet, devoted, all-in, no games",
  wildcard: "wildcard — unpredictable, can't be pinned down, keeps everyone guessing",
  surprise: "let the story pick a fitting archetype",
};

const OPENING_STYLES: Record<string, string> = {
  slow_build: "slow build — natural first meeting; the tension grows organically over the chapter",
  meet_cute: "meet-cute — an unexpected, memorable first encounter (a specific incident brings them together)",
  already_ten: "already-tension — they already have history when the story opens; the chapter joins mid-arc",
  one_night: "one night that becomes more — start with a charged single encounter that refuses to end there",
  forced: "forced together — proximity, situation, or circumstance forces closeness they didn't choose",
  fresh_start: "fresh start — new place or new life; the love interest is part of that new terrain",
  surprise: "let the story pick a fitting opening beat",
};

const HEAT_LEVEL_DIRECTIVES: Record<string, string> = {
  sweet: "SWEET — no explicit sexual content. Deep emotional/romantic weight is welcome. Physical intimacy stays off-page or closed-door.",
  spicy: `SPICY — explicit sexual content appears on the page in key scenes. Direct and sensory but not the constant focus. 1-2 substantial explicit scenes per chapter arc.

VOCABULARY (SPICY): body parts are named directly at the moment of intimacy — cock, breasts, nipples, clit, ass, wet, hard, come — not exclusively through euphemism (hardness, length, member, heat, core, center, sex, entrance). Some literary phrasing is fine between the direct words; the direct words must appear. Fluids and orgasm are named ("she came", "he came", not only "she shattered" or "he found release").`,
  very_spicy: `VERY SPICY — very explicit sexual content throughout. Multiple explicit scenes per chapter arc when the story calls for them.

VOCABULARY (VERY SPICY — MANDATORY): body parts named with common, direct, vulgar words during intimate scenes: cock, cunt, pussy, ass, asshole, clit, tits, nipples, thighs, hole. Fluids and acts named directly: cum, come, come inside, wet, soaking, hard, thick, load, fuck, fucking. Do NOT default to euphemism (hardness, length, member, sex, entrance, heat, center, core, folds, essence, arousal, release, climax alone). Some literary sentences between the vulgar words are fine — the goal is that the reader who asked for "very spicy" reads WORDS like cock and cunt in the prose, not only elegant abstractions. If a scene has a body doing something, use the vulgar noun once every 3-4 sentences at minimum during that scene. This is a contract with the reader; sanitising into pure metaphor is a failure of the brief.`,
};

// Mood chips → parameter bundles + prose directives.
// When multiple chips are picked, their directives stack.
const MOOD_CHIP_BUNDLES: Record<string, { label: string; directive: string }> = {
  soft_tender: {
    label: "Soft & tender",
    directive: "Gentleness in the emotional register. Slow physical intimacy when it happens. Kindness in the character voice.",
  },
  slow_burn: {
    label: "Slow burn tension",
    directive: "Delayed gratification. Extend anticipation. Physical release comes later than the reader wants — that's the point.",
  },
  playful_bratty: {
    label: "Playful & bratty",
    directive: "Push-and-pull energy. Teasing dialogue. One partner pushes, the other pushes back. Humor as foreplay.",
  },
  rough_care: {
    label: "Rough with real care",
    directive: "Intense physical dynamics with genuine care around them. Roughness is deliberate, not careless. Aftercare and reassurance are visible.",
  },
  dark_obsessive: {
    label: "Dark & obsessive",
    directive: "Morally gray or dangerous love interest. Obsession, possession, protection-through-control. High emotional stakes. Consent is present but the power dynamic is central.",
  },
  forbidden: {
    label: "Forbidden / risky",
    directive: "The romance shouldn't be happening — status, oath, role, or circumstance forbids it. The transgression is part of the appeal.",
  },
  sensual_worship: {
    label: "Sensual, worship-tempo",
    directive: "Slow, worshipful physicality. Focus on sensation, attention to the partner's body, drawn-out pleasure. Almost devotional register.",
  },
  multiple_partners: {
    label: "Multiple partners",
    directive: "Three or more partners involved. See the partner-dynamic drill for how they connect. Group scenes are expected somewhere in the arc.",
  },
};

// Specifics tags → directive additions (only apply when q6_spicy != 'sweet')
const SPECIFICS_DIRECTIVES: Record<string, string> = {
  praise: "Include praise-style dirty talk — worship language, verbal appreciation during intimate scenes.",
  instruction: "Include instructional dialogue — one partner directs the other during intimate scenes.",
  restraint: "Physical restraint is a featured element in intimate scenes (see restraint drill for level).",
  marking: "Include physical marking — bruises, hickeys, bites, or visible evidence of intensity that lingers.",
  slow_denial: "Feature edging, orgasm denial, extended anticipation as a scene structure.",
  public_watched: "Include public or being-watched scenarios (see voyeur drill for direction).",
  explicit_oral: "Explicit oral sex is on-page and detailed. Name the acts and body parts directly (mouth on cock, tongue on clit, sucking, licking) — not exclusively through euphemism.",
  explicit_anal: "Explicit anal is on-page and part of the scene work. Name it directly in the prose — ass, asshole, anal, in her ass, opening her — not 'from behind' or 'the other place'. The reader chose this on purpose; write it explicitly.",
  size_diff: "Physical size difference is a featured element (see size drill).",
  breeding: "Breeding kink / creampie themes — one partner marking the other internally, sometimes with dynasty or possession subtext. Name the act in the prose: come inside her, cum inside, fill her, breed her, load, seed. The act of finishing inside is spoken and named, not only implied through afterglow.",
  filthy_talk: "Explicit, direct, filthy dirty talk in dialogue during intimate scenes. Match the register the reader picked — do not sanitize.",
};

const BDSM_RESTRAINT_LEVELS: Record<string, string> = {
  held: "Physical control without bindings — hands, weight, position holds. No cuffs or ropes.",
  light: "Light bindings — silk ties, scarves, a hand held above the head. Symbolic more than restrictive.",
  real: "Real restraints — cuffs, rope, deliberate immobility. Bondage as intentional practice.",
  full: "Full bondage — advanced immobilization, extended restraint scenes. Higher-intensity practice.",
};

const BDSM_TALK_STYLES: Record<string, string> = {
  praise: 'Praise language: "perfect", "look at me", "so good".',
  instruction: 'Instructional language: "hold still", "eyes on me", "stay right there".',
  filthy_praise: "Filthy praise — worship + explicit mixed. Both registers at once.",
  degradation: "Degradation edge — this is a specific dynamic requested by the reader and framed as consensual/negotiated.",
  silent: "Almost silent — bodies do the talking. Minimal dialogue during intimate scenes.",
};

const BDSM_AFTERCARE: Record<string, string> = {
  warm: "Aftercare = warm and wrapped up. Held, blanket, physical closeness.",
  fed: "Aftercare = fed. Food or drink shared. Physical taking-care-of.",
  quiet: "Aftercare = quiet. No words needed. Just staying.",
  playful: "Aftercare = playful banter. Ease the intensity down with lightness.",
  fade: "Aftercare = fade to next scene. Don't linger post-scene.",
};

const DARK_LI_KINDS: Record<string, string> = {
  mafia: "Mafia / underworld love interest — organized crime setting, code of honor, dangerous world",
  villain: "Villain / antihero love interest — morally corrupt but drawn to protagonist",
  stalker: "Stalker energy — obsessive watching, tracking, presence before proper introduction",
  captor: "Captor / captivity dynamic — protagonist is held (physically, socially, or by circumstance)",
  gray: "Morally gray but not evil — powerful and dangerous but has a code they follow",
  full_villain: "Full villain, no redemption arc — dark to the core, but drawn to the protagonist",
};

const DARK_CONSENT_FLAVORS: Record<string, string> = {
  fully: "CONSENT: Fully consensual throughout. All intimate scenes involve clear, enthusiastic consent.",
  dubcon: "CONSENT: Dubcon-flavored — blurred lines that resolve as consensual within the scene. Character body responds, agency is present, but the framing plays with pressure and power imbalance.",
  cnc: "CONSENT: CNC — Consensual Non-Consent — negotiated fantasy of non-consent. Safewords and mutual agreement are established off-page in the world. The scene plays the fantasy while remaining a scene between consenting adults.",
  skip: "CONSENT: Skip dark consent territory — write dark love interest but keep intimate scenes fully consensual.",
};

const VOYEUR_STYLES: Record<string, string> = {
  watched: "Voyeur direction: protagonist is being watched during intimate scenes.",
  watching: "Voyeur direction: protagonist is watching the love interest / others during intimate scenes.",
  mutual: "Voyeur direction: watching each other (mirrors, filming inside the fiction, deliberate observation).",
  someone_else: "Voyeur direction: a third party is present during intimate scenes (deliberate, consensual).",
  risk_only: "Voyeur direction: public risk without actual audience — the possibility of being seen adds tension.",
};

const OMEGAVERSE_TAGS: Record<string, string> = {
  heat: "Heat cycles as story engine",
  knot: "Knotting is featured",
  bond: "Permanent mating bonds",
  scent: "Scenting / claiming rituals",
  rivals: "Rival alphas / competition",
  find_pair: "Finding-your-mate storyline",
};

// ═══════════════════════════════════════════════════════════════════════════════
// Q9 filter — removes conflicting picks before the prompt is built
// ═══════════════════════════════════════════════════════════════════════════════

interface ResolvedFilters {
  ban_kink: boolean;       // strip all BDSM specifics + drill data
  ban_dark: boolean;       // strip dark_obsessive/forbidden mood + dark drills
  ban_multi_partner: boolean;
  ban_voyeur: boolean;
  enforce_enthusiastic_consent: boolean;  // override d_dark_consent to 'fully'
  free_text_skips: string; // raw user text, injected as HIGHEST PRIORITY
}

function resolveQ9Filters(q9?: Quiz2Context["q9_skip"]): ResolvedFilters {
  const base: ResolvedFilters = {
    ban_kink: false,
    ban_dark: false,
    ban_multi_partner: false,
    ban_voyeur: false,
    enforce_enthusiastic_consent: false,
    free_text_skips: "",
  };

  if (!q9 || q9.open_any) return base;

  const specifics = q9.specifics ?? [];

  if (specifics.includes("traditional_only")) {
    base.ban_kink = true;
    base.ban_dark = true;
    base.ban_multi_partner = true;
    base.ban_voyeur = true;
  }
  if (specifics.includes("no_kink")) base.ban_kink = true;
  if (specifics.includes("no_dark")) base.ban_dark = true;
  if (specifics.includes("enthusiastic_consent")) base.enforce_enthusiastic_consent = true;
  // "no_bestiality" is a signal (engine never generates that anyway); no filter change needed
  // "no_kink" and "no_dark" are already covered above

  base.free_text_skips = (q9.free_text ?? "").trim();

  return base;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Prompt section builders
// ═══════════════════════════════════════════════════════════════════════════════

function buildPovBlock(quiz: Quiz2Context): { pov: "second" | "third"; block: string } {
  const isSelfInsert = quiz.q1_in_story === "yes";

  if (isSelfInsert) {
    const you = quiz.q1b_you ?? {};
    const name = (you.name ?? "").trim();
    const genderLabel = { woman: "a woman", man: "a man", nb: "non-binary" }[you.gender ?? "woman"];
    const displayName = name || "the reader";
    return {
      pov: "second",
      block: `POV: SECOND PERSON. The reader IS the protagonist.
Reader identity: ${displayName} (${genderLabel}).
Address the reader as "you" throughout. Refer to them by name in dialogue when other characters speak to them.`,
    };
  }

  return {
    pov: "third",
    block: `POV: THIRD PERSON. The reader is not in the story — they are reading about invented characters. Give the protagonist a fitting name and describe them from the outside.`,
  };
}

function buildPairingBlock(quiz: Quiz2Context): string {
  const key = quiz.q2_pairing ?? "surprise";
  return `PAIRING: ${PAIRING_DESCRIPTIONS[key] ?? PAIRING_DESCRIPTIONS.surprise}`;
}

function buildWorldBlock(quiz: Quiz2Context): string {
  const key = quiz.q3_world ?? "surprise";
  return `WORLD: ${WORLD_DESCRIPTIONS[key] ?? WORLD_DESCRIPTIONS.surprise}`;
}

function buildLoveInterestBlock(quiz: Quiz2Context, filters: ResolvedFilters): string {
  const archetypeKey = quiz.q4_love_interest ?? "surprise";
  const base = `LOVE INTEREST ARCHETYPE: ${LOVE_INTEREST_ARCHETYPES[archetypeKey] ?? LOVE_INTEREST_ARCHETYPES.surprise}`;

  // If Full mode + Dark drill + not banned, add specificity
  if (quiz.q8b_setup_depth === "full" && quiz.d_dark_kind && !filters.ban_dark) {
    return base + "\n" + `DARK LOVE INTEREST FLAVOR: ${DARK_LI_KINDS[quiz.d_dark_kind] ?? ""}`;
  }
  return base;
}

function buildOpeningBlock(quiz: Quiz2Context): string {
  const key = quiz.q5_opening ?? "surprise";
  return `STORY OPENING STYLE: ${OPENING_STYLES[key] ?? OPENING_STYLES.surprise}`;
}

function buildHeatBlock(quiz: Quiz2Context): string {
  const key = quiz.q6_spicy ?? "spicy";
  return `HEAT LEVEL: ${HEAT_LEVEL_DIRECTIVES[key]}`;
}

function buildMoodBlock(quiz: Quiz2Context, filters: ResolvedFilters): string {
  let moods = quiz.q7_mood ?? [];

  // Filter out banned moods
  if (filters.ban_dark) {
    moods = moods.filter((m) => m !== "dark_obsessive" && m !== "forbidden");
  }
  if (filters.ban_multi_partner) {
    moods = moods.filter((m) => m !== "multiple_partners");
  }

  if (moods.length === 0) {
    return "MOOD: Engine's choice — pick a coherent mood register that fits the world and heat level.";
  }

  const bundles = moods
    .map((m) => MOOD_CHIP_BUNDLES[m])
    .filter(Boolean);

  const lines = bundles.map((b) => `- ${b.label}: ${b.directive}`);
  return `MOOD DIRECTIVES:\n${lines.join("\n")}`;
}

function buildSpecificsBlock(quiz: Quiz2Context, filters: ResolvedFilters): string {
  if (quiz.q6_spicy === "sweet") return ""; // Sweet stories have no specifics
  if (quiz.q8b_setup_depth !== "full") return ""; // Specifics only in Full mode

  let specifics = quiz.q8_specifics ?? [];
  if (filters.ban_kink) {
    // Strip kink-adjacent specifics
    const kinkLikeSpecifics = ["restraint", "marking", "slow_denial", "filthy_talk", "explicit_anal", "breeding"];
    specifics = specifics.filter((s) => !kinkLikeSpecifics.includes(s));
  }

  if (specifics.length === 0) return "";

  const lines = specifics
    .map((s) => SPECIFICS_DIRECTIVES[s])
    .filter(Boolean)
    .map((d) => `- ${d}`);

  return `SPECIFIC CONTENT DIRECTIVES:\n${lines.join("\n")}`;
}

function buildBdsmDrillBlock(quiz: Quiz2Context, filters: ResolvedFilters): string {
  if (filters.ban_kink) return "";
  if (quiz.q8b_setup_depth !== "full") return "";

  const parts: string[] = [];

  if (quiz.d_restraint) {
    parts.push(`Restraint level: ${BDSM_RESTRAINT_LEVELS[quiz.d_restraint] ?? ""}`);
  }
  if (quiz.d_sensory && quiz.d_sensory.length > 0) {
    parts.push(`Sensory play: ${quiz.d_sensory.join(", ")}`);
  }
  if (quiz.d_talk && quiz.d_talk.length > 0) {
    const talkDirectives = quiz.d_talk.map((t) => BDSM_TALK_STYLES[t]).filter(Boolean).join(" ");
    parts.push(`Intimate talk style: ${talkDirectives}`);
    parts.push(`STRICT VOICE RULE: use ONLY the talk styles listed above. Do NOT drift into other registers — for example, if only "instruction" is picked, do NOT add praise language like "good girl" or "perfect".`);
  }
  if (quiz.d_aftercare) {
    parts.push(BDSM_AFTERCARE[quiz.d_aftercare] ?? "");
  }

  if (parts.length === 0) return "";
  return `BDSM SPECIFICS:\n${parts.map((p) => "- " + p).join("\n")}`;
}

function buildWorldDrillBlock(quiz: Quiz2Context): string {
  if (quiz.q8b_setup_depth !== "full") return "";
  const parts: string[] = [];

  if (quiz.d_paranormal_kind && quiz.d_paranormal_kind.length > 0) {
    parts.push(`Paranormal type(s): ${quiz.d_paranormal_kind.join(", ")}`);
  }
  if (quiz.d_monster_flavor && quiz.d_monster_flavor.length > 0) {
    parts.push(`Monster type(s): ${quiz.d_monster_flavor.join(", ")}. Reminder: intelligent beings only, never actual animals.`);
  }
  if (quiz.d_omegaverse && quiz.d_omegaverse.length > 0) {
    const tags = quiz.d_omegaverse.map((t) => OMEGAVERSE_TAGS[t] ?? t).join(", ");
    parts.push(`Omegaverse dynamics: ${tags}`);
  }
  if (quiz.d_size && quiz.d_size !== "skip") {
    const sizeMap: Record<string, string> = {
      massive: "MASSIVE — play the physical impossibility for tension and intimacy",
      significant: "SIGNIFICANT — noticeable but grounded",
      present: "PRESENT — mentioned, not the focus",
    };
    parts.push(`Size/power difference: ${sizeMap[quiz.d_size] ?? ""}`);
  }

  if (parts.length === 0) return "";
  return `WORLD SPECIFICS:\n${parts.map((p) => "- " + p).join("\n")}`;
}

function buildPartnerDrillBlock(quiz: Quiz2Context, filters: ResolvedFilters): string {
  if (filters.ban_multi_partner) return "";
  if (quiz.q8b_setup_depth !== "full") return "";
  if (!quiz.d_partner_dynamic) return "";

  const dynamicMap: Record<string, string> = {
    mutual: "Fully mutual — everyone with everyone.",
    centered: "Centered on the main character — they are the focus of all partners.",
    two_plus_one: "Two-plus-one — one primary partner with occasional third.",
    hierarchical: "Hierarchical — one alpha primary, others secondary.",
    decide: "Let the story figure out how they connect.",
  };

  return `MULTI-PARTNER DYNAMIC: ${dynamicMap[quiz.d_partner_dynamic] ?? ""}`;
}

function buildDarkDrillBlock(quiz: Quiz2Context, filters: ResolvedFilters): string {
  if (filters.ban_dark) return "";
  if (quiz.q8b_setup_depth !== "full") return "";

  const parts: string[] = [];
  // d_dark_kind is already included in the love interest block; don't duplicate here
  if (quiz.d_dark_consent) {
    // If enthusiastic-consent is enforced, override dubcon/cnc to fully
    const consentKey = filters.enforce_enthusiastic_consent
      ? "fully"
      : quiz.d_dark_consent;
    if (consentKey !== "skip") {
      parts.push(DARK_CONSENT_FLAVORS[consentKey] ?? "");
    }
  }

  if (parts.length === 0) return "";
  return `DARK SCENE DIRECTIVES:\n${parts.map((p) => "- " + p).join("\n")}\n\nFICTIONAL FANTASY ONLY. All characters are consenting adults; the safety floor above defines how the intensity is framed.`;
}

function buildVoyeurDrillBlock(quiz: Quiz2Context, filters: ResolvedFilters): string {
  if (filters.ban_voyeur) return "";
  if (quiz.q8b_setup_depth !== "full") return "";
  if (!quiz.d_voyeur) return "";
  return VOYEUR_STYLES[quiz.d_voyeur] ?? "";
}

function buildHardLimitsBlock(quiz: Quiz2Context, filters: ResolvedFilters): string {
  const bans: string[] = [];

  // Universal hard-refuses (always in place regardless of quiz)
  bans.push("NEVER include sexual content involving minors under any framing.");
  bans.push("NEVER include actual animals in sexual scenarios (monster/paranormal beings with personhood are allowed and different).");
  bans.push("NEVER frame non-consent as arousing or acceptable (CNC drill, if picked, is negotiated fantasy — not real non-consent).");
  bans.push("NEVER depict real named public figures in sexual scenarios.");

  // Q9-driven bans
  if (filters.ban_kink) bans.push("Skip: no kink, no BDSM elements, no restraint, no impact.");
  if (filters.ban_dark) bans.push("Skip: no dark themes, no mafia/villain/stalker/captor dynamics, no dubcon.");
  if (filters.ban_multi_partner) bans.push("Skip: no multiple-partner scenes.");
  if (filters.ban_voyeur) bans.push("Skip: no public/being-watched scenes.");
  if (filters.enforce_enthusiastic_consent) bans.push("Every intimate scene must feature clear, enthusiastic, unambiguous consent.");

  if (filters.free_text_skips) {
    bans.push(`USER'S ADDITIONAL SKIP LIST (highest priority — respect this literally): ${filters.free_text_skips}`);
  }

  return `HARD LIMITS — these override anything above:\n${bans.map((b) => "- " + b).join("\n")}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Variety block (mirrors V1 shape but adapted for V2 quiz answers)
// ═══════════════════════════════════════════════════════════════════════════════

function buildVarietyBlock(variety?: VarietyContext): string {
  if (!variety) return "";
  const bucketExamples = variety.bucket.examples.map((e) => `"${e}"`).join(", ");
  const priorBlock = variety.priorStories.length === 0
    ? "This user has no prior stories. Use your full creative range."
    : `Prior stories by this reader (most recent first):
${variety.priorStories.map((s, i) => {
  const lines = [`${i + 1}.`, `   Title: ${s.title ?? "(none)"}`];
  if (s.character_archetype) lines.push(`   Characters: ${s.character_archetype}`);
  if (s.setting_type) lines.push(`   Setting: ${s.setting_type}`);
  if (s.opening_excerpt) lines.push(`   Opening: "${s.opening_excerpt.replace(/\n/g, " ").slice(0, 120)}..."`);
  return lines.join("\n");
}).join("\n\n")}

Make this new story feel categorically different from the priors. No name reuse. No echoed opening structure. No same setting type.`;

  return `

=== VARIETY CONSTRAINTS ===

CREATIVE SEED FOR THIS STORY:
"${variety.seed}"

Weave the seed in as texture (mood, sensory atmosphere, quiet detail) — never as a plot driver.

TITLE STYLE BUCKET:
${variety.bucket.name}
Reference titles in this style: ${bucketExamples}
Write STORY_TITLE that fits the structural feel — 2–6 words, book-spine energy.

${priorBlock}

=== END VARIETY CONSTRAINTS ===

`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Chapter 1 prompt
// ═══════════════════════════════════════════════════════════════════════════════

export function chapter1PromptV2(
  quiz: Quiz2Context,
  targetChapterCount = 10,
  variety?: VarietyContext,
): string {
  const filters = resolveQ9Filters(quiz.q9_skip);
  const { pov, block: povBlock } = buildPovBlock(quiz);
  const varietyBlock = buildVarietyBlock(variety);

  const parameterBlocks = [
    povBlock,
    buildPairingBlock(quiz),
    buildWorldBlock(quiz),
    buildLoveInterestBlock(quiz, filters),
    buildOpeningBlock(quiz),
    buildHeatBlock(quiz),
    buildMoodBlock(quiz, filters),
    buildSpecificsBlock(quiz, filters),
    buildBdsmDrillBlock(quiz, filters),
    buildWorldDrillBlock(quiz),
    buildPartnerDrillBlock(quiz, filters),
    buildDarkDrillBlock(quiz, filters),
    buildVoyeurDrillBlock(quiz, filters),
  ].filter((s) => s.trim().length > 0).join("\n\n");

  const hardLimitsBlock = buildHardLimitsBlock(quiz, filters);

  return `You are writing chapter 1 of a personalized, premium interactive romance story based on a reader quiz. This is a pure content-generation task.${varietyBlock}

Your job is to produce:
1. A high-quality chapter 1 story
2. Structured story metadata for storage in a database
3. Exactly 3 strong next-step options for chapter 2

The output must be clean, consistent, and easy to parse.

═══ STORY PARAMETERS (from reader quiz) ═══

${parameterBlocks}

═══ HARD LIMITS ═══

${hardLimitsBlock}

═══ INSTRUCTIONS ═══

- Return ONLY the labeled fields below.
- Use the exact labels exactly as written.
- Do not add any introduction, explanation, markdown, bullet list, code fences, or closing note.
- Do not skip any field.
- Each label must appear once.
- Put the value directly under its label.
- Write in ${pov === "second" ? "SECOND PERSON — address the reader as 'you'" : "THIRD PERSON — third-person past tense about invented characters"}.
- Honor the mood, heat, love interest, world, and specifics directives above.
- HARD LIMITS override any conflicting directive — respect them absolutely.
- Write immersive, commercially readable prose.
- Keep the tone consistent with the mood chips and archetype.
- The 3 next options must be clearly different from each other but all plausible continuations.
- Limit CHAPTER_1_TEXT to approximately 2000 words. Do not exceed 2300 words.
- Do not repeat labels inside the field values.

${FAILSAFE_BLOCK}

═══ OUTPUT FORMAT ═══

STORY_TITLE:
[compelling short title, 2–6 words]

STORY_GENRE:
[genre, e.g. "Contemporary Romance / Erotic Fiction"]

TONE_LABEL:
[short tone label, 2–4 words]

HEAT_LEVEL:
[echo the heat level: Sweet | Spicy | Very Spicy]

SETTING_TYPE:
[primary setting]

FANTASY_TYPE:
[core fantasy type — 2-3 words]

RELATIONSHIP_DYNAMIC:
[main relationship dynamic]

CHARACTER_ARCHETYPE:
[dominant archetype or pairing archetype]

STORY_HOOK:
[1 sentence hook]

OPENING_PREMISE:
[1-2 sentence opening premise]

ORIGINAL_SETUP:
[1-2 sentence setup summary]

CHAPTER_1_TEXT:
[full chapter 1 story, ~2000 words]

CHAPTER_1_SUMMARY:
[concise 1-2 sentence summary]

CHAPTER_1_MOOD:
[chapter mood]

CHAPTER_1_KEY_EVENT:
[key turning point]

CHAPTER_1_CLOSURE_HOOK:
[ending hook pulling into chapter 2]

GLOBAL_SUMMARY:
[concise summary of overall story direction so far]

STORY_BIBLE_SUMMARY:
[compact story bible summary for continuity]

WORLD_RULES:
[world's emotional/social/setting rules]

WORLD_STATE:
[current external world state after chapter 1]

CHARACTER_STATE:
[main emotional and internal state of characters after chapter 1]

RELATIONSHIP_MAP:
[relationship dynamic snapshot]

TIMELINE_STATE:
[where we are in the timeline]

OPEN_LOOPS:
[unresolved questions, tensions, threads]

RESOLVED_LOOPS:
[what has been resolved in chapter 1]

ITEMS_OF_IMPORTANCE:
[important objects, details, or motifs]

SECRETS_AND_REVEALS:
[hidden truths, reveals, or withheld information]

NEXT_CHAPTER_GOAL:
[what chapter 2 should try to achieve]

NEXT_CHAPTER_ARC_POSITION:
[where chapter 2 sits in the bigger arc]

NEXT_CHAPTER_TONE_HINT:
[short tone hint for chapter 2]

NEXT_CHAPTER_STAKES_LEVEL:
[stakes level]

NEXT_OPTIONS_1:
[option 1 for how chapter 2 could continue]

NEXT_OPTIONS_2:
[option 2 for how chapter 2 could continue]

NEXT_OPTIONS_3:
[option 3 for how chapter 2 could continue]

═══ METADATA (for context only, do not echo back) ═══

current_chapter_number: 1
target_chapter_count: ${targetChapterCount}
quiz_version: 2`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Chapter N prompt (2..10)
// ═══════════════════════════════════════════════════════════════════════════════

export interface ChapterNContextV2 {
  chapterNumber: number;
  quiz: Quiz2Context; // used to enforce continuity of mood/heat/hard-limits
  storyMetadata: {
    genre?: string; tone?: string; heat?: string; setting?: string;
    fantasy?: string; dynamic?: string; archetype?: string;
  };
  globalSummary?: string;
  worldState?: string;
  characterState?: string;
  relationshipMap?: string;
  timelineState?: string;
  openLoops?: string;
  prevChapter: {
    summary?: string; mood?: string; keyEvent?: string; closureHook?: string;
  };
  userChoiceText: string;
  nextIntent: {
    goal?: string; arcPosition?: string; toneHint?: string; stakesLevel?: string;
  };
}

export function chapterNPromptV2(ctx: ChapterNContextV2): string {
  const n = ctx.chapterNumber;
  const v = (x: string | undefined) => (x ?? "").trim() || "(unspecified)";
  const filters = resolveQ9Filters(ctx.quiz.q9_skip);
  const { pov } = buildPovBlock(ctx.quiz);
  const hardLimitsBlock = buildHardLimitsBlock(ctx.quiz, filters);

  return `You are writing chapter ${n} of a personalized, premium interactive romance story.

Your job is to:
1. Continue the story based on the selected option
2. Maintain full continuity with previous chapters
3. Update structured story state
4. Generate 3 strong next-step options for the upcoming chapter

The output must be clean, consistent, and easy to parse.

═══ HARD LIMITS (from reader quiz — always in force) ═══

${hardLimitsBlock}

═══ FAILSAFE ═══

${FAILSAFE_BLOCK}

═══ INSTRUCTIONS ═══

- Return ONLY the labeled fields below.
- Use exact labels exactly as written.
- Do not add introduction, explanation, markdown, bullet list, or extra text.
- Do not skip any field. Each label appears once.
- Put the value directly under its label.
- Write in ${pov === "second" ? "SECOND PERSON — address the reader as 'you'" : "THIRD PERSON — third-person past tense"}.
- Maintain tone, genre, and heat level consistency established in chapter 1.
- Respect the world, character states, and dynamics from prior chapters.
- The selected option below must clearly influence this chapter's events.
- The 3 next options must be clearly different and plausible.
- Keep structured fields concise but useful.
- Limit CHAPTER_TEXT to approximately 2000 words (max 2300).
- Vary the opening sentence structure each chapter — do not begin the chapter with "You don't" or a repeated pattern from earlier chapters.

═══ STORY CONTEXT ═══

Genre: ${v(ctx.storyMetadata.genre)}
Tone: ${v(ctx.storyMetadata.tone)}
Heat level: ${v(ctx.storyMetadata.heat)}
Setting: ${v(ctx.storyMetadata.setting)}
Fantasy: ${v(ctx.storyMetadata.fantasy)}
Dynamic: ${v(ctx.storyMetadata.dynamic)}
Archetype: ${v(ctx.storyMetadata.archetype)}

GLOBAL SUMMARY:
${v(ctx.globalSummary)}

WORLD STATE:
${v(ctx.worldState)}

CHARACTER STATE:
${v(ctx.characterState)}

RELATIONSHIP MAP:
${v(ctx.relationshipMap)}

TIMELINE STATE:
${v(ctx.timelineState)}

OPEN LOOPS:
${v(ctx.openLoops)}

═══ PREVIOUS CHAPTER ═══

Summary: ${v(ctx.prevChapter.summary)}
Mood: ${v(ctx.prevChapter.mood)}
Key event: ${v(ctx.prevChapter.keyEvent)}
Closure hook: ${v(ctx.prevChapter.closureHook)}

═══ USER'S CHOICE (must clearly influence this chapter) ═══

${ctx.userChoiceText}

═══ NEXT CHAPTER INTENT ═══

Goal: ${v(ctx.nextIntent.goal)}
Arc position: ${v(ctx.nextIntent.arcPosition)}
Tone hint: ${v(ctx.nextIntent.toneHint)}
Stakes: ${v(ctx.nextIntent.stakesLevel)}

═══ OUTPUT FORMAT ═══

CHAPTER_TEXT:
[full chapter story, ~2000 words]

CHAPTER_SUMMARY:
[1-2 sentence summary]

CHAPTER_MOOD:
[chapter mood]

CHAPTER_KEY_EVENT:
[key turning point]

CHAPTER_CLOSURE_HOOK:
[ending hook]

GLOBAL_SUMMARY:
[updated global summary]

WORLD_STATE:
[updated world state]

CHARACTER_STATE:
[updated character state]

RELATIONSHIP_MAP:
[updated relationship snapshot]

TIMELINE_STATE:
[updated timeline]

OPEN_LOOPS:
[updated unresolved threads]

NEXT_CHAPTER_GOAL:
[next chapter goal]

NEXT_CHAPTER_ARC_POSITION:
[arc position]

NEXT_CHAPTER_TONE_HINT:
[tone hint]

NEXT_CHAPTER_STAKES_LEVEL:
[stakes level]

NEXT_OPTIONS_1:
[option 1]

NEXT_OPTIONS_2:
[option 2]

NEXT_OPTIONS_3:
[option 3]`;
}
