// Creative-variety scaffolding for chapter-1 generation.
//
// Three orthogonal levers that ensure stories diverge meaningfully even when
// quiz inputs are nearly identical and even for the same user across calls:
//
//   1. Title style bucket — random pick per story. Forces structural variety
//      in title syntax (declarative, question, location-anchored, etc.).
//   2. Secret seed — random pick from a 100-item library of atmospheric/object/
//      tonal/contextual anchors. Woven into the story texture, not its plot.
//   3. Per-user anti-context (built dynamically in generate-chapter from the
//      user's actual prior stories) — Claude analyzes its own past output for
//      this user and steers categorically different.

export interface TitleBucket {
  name: string;
  examples: string[];
}

export const TITLE_BUCKETS: TitleBucket[] = [
  {
    name: "atmospheric",
    examples: ["Tonight in the Glass House", "After the Rain Stopped", "All Light, No Honey"],
  },
  {
    name: "possessive",
    examples: ["His Quiet Hours", "Her Sharp Edges", "What He Wouldn't Say"],
  },
  {
    name: "kinetic",
    examples: ["Three Knocks After Midnight", "Burn It All Down", "Catch Me When I Fall"],
  },
  {
    name: "object_symbol",
    examples: ["Black Door, Velvet Lock", "The Brass Key", "A Cigarette Between Strangers"],
  },
  {
    name: "location",
    examples: ["The House at the End of August", "Twelve Floors Down", "Above the Harbor"],
  },
  {
    name: "mythic_dark",
    examples: ["And the Sea Said My Name", "Ash on the Pillow", "Honey Where the Knife Was"],
  },
  {
    name: "declarative",
    examples: ["I Said Yes", "She Lied", "Stay"],
  },
  {
    name: "time_bound",
    examples: ["Tuesday, in Pieces", "Year of the Black Moon", "One Hour to Sunrise"],
  },
  {
    name: "sensory",
    examples: ["Salt and Wire", "Smoke Like Skin", "Velvet, Bone, and Yes"],
  },
  {
    name: "question",
    examples: ["Will You Forget Me Tomorrow?", "What Do You Want?", "Why Now?"],
  },
  {
    name: "playful_modern",
    examples: ["The Group Chat from Hell", "Bad Idea, Good Tuesday", "Honestly, Yes"],
  },
  {
    name: "numerical",
    examples: ["Six Knots, One Mouth", "Two Truths", "Forty Days Until"],
  },
];

// 100 textural anchors. Each story injects exactly one as a mood/scene seed.
// Mix of atmospheric (25), object/motif (25), emotional/tonal (25), and
// contextual/quirk (25). Tuned to be evocative without dictating plot.
export const SECRET_SEEDS: string[] = [
  // ===== ATMOSPHERIC / SENSORY (25) =====
  "A thunderstorm building in the distance",
  "Lavender, late in the season",
  "Morning fog so thick it muffles sound",
  "Cold tile under bare feet",
  "Smoke from a kitchen across the way",
  "Salt air carried inland by a strange wind",
  "The hum of an old refrigerator at 3am",
  "Rain on a tin roof",
  "A church bell three streets over",
  "Pollen drifting through afternoon light",
  "The smell of wet asphalt in summer",
  "Candlelight reflected in dark water",
  "Snow muffling a city",
  "A heatwave that won't break",
  "Dust suspended in a sunbeam",
  "The first cold morning of autumn",
  "Steam off a coffee cup in a cold room",
  "Honeysuckle climbing a back fence",
  "The crackle of a record between songs",
  "Wood smoke and pine",
  "The blue light before dawn",
  "A wind that smells like rain",
  "The drone of cicadas at dusk",
  "A power line humming in the heat",
  "The metallic taste before a thunderstorm",

  // ===== OBJECT / MOTIF (25) =====
  "A letter that was never sent",
  "An old key on a forgotten ring",
  "A phone left on read for two days",
  "A scar she never explained",
  "His grandmother's brass lighter",
  "A book with someone else's notes in the margins",
  "An unmade bed at noon",
  "A ribbon tied to a tree",
  "A pair of shoes left by a door",
  "A photograph turned face-down",
  "A single matchbook from a hotel that no longer exists",
  "A bracelet with no clasp",
  "An envelope marked 'later'",
  "A music box that won't quite close",
  "A coat that smells like someone else",
  "Two glasses on a table, one nearly full",
  "A passport that hasn't been used in years",
  "A vinyl record with a worn jacket",
  "A bookmark left at page 47",
  "A cracked window not yet replaced",
  "A drawer that doesn't open easily",
  "A spare house key under a stone",
  "A handwritten recipe with no signature",
  "A pocket watch that doesn't keep time",
  "A scarf left on the wrong chair",

  // ===== EMOTIONAL / TONAL (25) =====
  "The courage of liars",
  "An apology that arrives weeks late",
  "Patient hunger",
  "Half-remembered lullabies",
  "The kindness of strangers in motels",
  "A name she doesn't say out loud",
  "Wry surrender",
  "The strange relief of being recognized",
  "A grudge you've outgrown but kept",
  "Faith in the wrong people",
  "The dignity of going first",
  "Almost-laughter",
  "The bravery of asking twice",
  "Old jealousy in new clothes",
  "Tender stubbornness",
  "The mercy of plain words",
  "A grief that wears practical shoes",
  "The slow understanding that you were wrong",
  "Hope that arrives a beat too late",
  "The peculiar tenderness of secrets",
  "Forgiveness that costs something",
  "Quiet defiance",
  "The relief of being interrupted",
  "A confession you didn't plan to make",
  "The small dignity of restraint",

  // ===== CONTEXTUAL / QUIRK (25) =====
  "Eye contact half a second too long",
  "A power outage on the wrong night",
  "The third song on a playlist she's forgotten",
  "A wrong number that becomes the right one",
  "Two hours of silence neither breaks",
  "A storm canceling everyone else's plans",
  "A childhood friend you barely recognize",
  "The waiter who keeps refilling the wine",
  "A taxi that arrives early",
  "An elevator that stops between floors",
  "A delayed flight no one minds",
  "A cat that won't leave the bed",
  "A neighbor's argument carrying through the wall",
  "A waitress who knows their order",
  "A spilled drink at exactly the wrong moment",
  "A song neither of them admits to liking",
  "A meeting cut short by weather",
  "A locked door with someone on the other side",
  "A long walk taken alone",
  "A photograph she takes without warning",
  "A name spelled wrong on a coffee cup",
  "A bookshop closing early",
  "The last train leaving the station",
  "A dog that picks them",
  "A laugh that surprises her",
];

export function pickRandomBucket(): TitleBucket {
  return TITLE_BUCKETS[Math.floor(Math.random() * TITLE_BUCKETS.length)];
}

export function pickRandomSeed(): string {
  return SECRET_SEEDS[Math.floor(Math.random() * SECRET_SEEDS.length)];
}

// ----- Anti-context shape passed into chapter1Prompt -----
export interface PriorStorySnapshot {
  title?: string | null;
  character_archetype?: string | null;
  setting_type?: string | null;
  opening_excerpt?: string | null;  // first ~120 chars of chapter 1 text
}

export interface VarietyContext {
  bucket: TitleBucket;
  seed: string;
  priorStories: PriorStorySnapshot[];
}
