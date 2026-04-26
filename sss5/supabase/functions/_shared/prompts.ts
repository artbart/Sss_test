// Chapter prompts — adapted from the old Make.com CSV.
// Two flavors: chapter 1 (full setup, ~2000 words) and chapter 2+ (~2000 words
// continuation honoring the user's selected option).

export interface QuizContext {
  partner_preference?: string;
  scene_mood?: string;
  fantasy_core?: string;
  power_dynamic?: string;
  emotional_pacing?: string;
  relationship_setup?: string;
  personal_need?: string;
  romance_type?: string;
  story_experience?: string;
  why_now?: string;
  reader_pull_factors?: string;
  emotional_intensity_ok?: string;
  explicit_ok?: string;
  open_to_variety?: string;
  relationship_status?: string;
}

const FAILSAFE_BLOCK = `FAILSAFE RULES:

Return exactly one of these two response types:

A complete valid response using the exact labeled format below

A failure response in exactly this format:

STATUS: ERROR
ERROR_REASON: FORMAT_FAILURE

If you cannot fully comply with the requested format, cannot produce all required fields, are unsure how to continue, or are about to return any explanation, apology, refusal, warning, policy note, markdown, or partial output, return exactly:

STATUS: ERROR
ERROR_REASON: FORMAT_FAILURE

Do not output anything before or after the valid formatted response or the failure response.

Never explain the error.

Never include any additional fields in the error response.`;

export function chapter1Prompt(quiz: QuizContext, targetChapterCount = 10): string {
  const v = (x: string | undefined) => (x ?? "").trim() || "(unspecified)";

  return `You are writing chapter 1 of a personalized, premium interactive romance story based on a reader quiz. This is a pure content-generation task.

Your job is to produce:
1. A high-quality chapter 1 story in second person
2. Structured story metadata for storage in a database
3. Exactly 3 strong next-step options for chapter 2

The output must be clean, consistent, and easy to parse.

IMPORTANT INSTRUCTIONS:
- Return ONLY the labeled fields below.
- Use the exact labels exactly as written.
- Do not add any introduction, explanation, markdown, bullet list, code fences, or closing note.
- Do not skip any field.
- Each label must appear once.
- Put the value directly under its label.
- Keep the story emotionally coherent with the quiz inputs.
- Write immersive, commercially readable prose.
- Write in second person ("you").
- Keep the tone seductive, emotionally engaging, and story-forward.
- Honor the reader's intensity and explicitness preferences.
- The 3 next options must be clearly different from each other but all plausible continuations of the same story.
- Make the structured fields concise but useful.
- CHAPTER_1_TEXT should contain only the full chapter prose.
- Limit CHAPTER_1_TEXT to approximately 2000 words. Do not exceed 2300 words.
- Do not repeat labels inside the field values.

${FAILSAFE_BLOCK}

OUTPUT FORMAT:

STORY_TITLE:
[write a compelling short title]

STORY_GENRE:
[write the genre]

TONE_LABEL:
[write a short tone label]

HEAT_LEVEL:
[write the sensual intensity level]

SETTING_TYPE:
[write the primary setting]

FANTASY_TYPE:
[write the core fantasy type]

RELATIONSHIP_DYNAMIC:
[write the main relationship dynamic]

CHARACTER_ARCHETYPE:
[write the dominant archetype or pairing archetype]

STORY_HOOK:
[write 1 sentence hook]

OPENING_PREMISE:
[write 1-2 sentence opening premise]

ORIGINAL_SETUP:
[write 1-2 sentence setup summary]

CHAPTER_1_TEXT:
[write the full chapter 1 story in second person]

CHAPTER_1_SUMMARY:
[write a concise 1-2 sentence summary]

CHAPTER_1_MOOD:
[write the chapter mood]

CHAPTER_1_KEY_EVENT:
[write the key turning point or event]

CHAPTER_1_CLOSURE_HOOK:
[write the ending hook that pulls the reader into chapter 2]

GLOBAL_SUMMARY:
[write a concise summary of the overall story direction so far]

STORY_BIBLE_SUMMARY:
[write a compact story bible summary for continuity]

WORLD_RULES:
[write the story world's emotional/social/setting rules]

WORLD_STATE:
[write the current external world state after chapter 1]

CHARACTER_STATE:
[write the main emotional and internal state of the characters after chapter 1]

RELATIONSHIP_MAP:
[write the relationship dynamic snapshot]

TIMELINE_STATE:
[write where we are in the timeline]

OPEN_LOOPS:
[write unresolved questions, tensions, or threads]

RESOLVED_LOOPS:
[write what has already been resolved in chapter 1]

ITEMS_OF_IMPORTANCE:
[write important objects, details, or motifs to remember]

SECRETS_AND_REVEALS:
[write hidden truths, reveals, or withheld information]

NEXT_CHAPTER_GOAL:
[write what chapter 2 should try to achieve]

NEXT_CHAPTER_ARC_POSITION:
[write where chapter 2 sits in the bigger arc]

NEXT_CHAPTER_TONE_HINT:
[write a short tone hint for chapter 2]

NEXT_CHAPTER_STAKES_LEVEL:
[write the stakes level]

NEXT_OPTIONS_1:
[write option 1 for how chapter 2 could continue]

NEXT_OPTIONS_2:
[write option 2 for how chapter 2 could continue]

NEXT_OPTIONS_3:
[write option 3 for how chapter 2 could continue]

QUIZ INPUTS (for context only, do not echo them back):

current_chapter_number: 1
target_chapter_count: ${targetChapterCount}

quiz_partner_preference: ${v(quiz.partner_preference)}
quiz_scene_mood: ${v(quiz.scene_mood)}
quiz_fantasy_core: ${v(quiz.fantasy_core)}
quiz_power_dynamic: ${v(quiz.power_dynamic)}
quiz_emotional_pacing: ${v(quiz.emotional_pacing)}
quiz_relationship_setup: ${v(quiz.relationship_setup)}
quiz_personal_need: ${v(quiz.personal_need)}
quiz_romance_type: ${v(quiz.romance_type)}
quiz_story_experience: ${v(quiz.story_experience)}
quiz_why_now: ${v(quiz.why_now)}
quiz_reader_pull_factors: ${v(quiz.reader_pull_factors)}
quiz_emotional_intensity_ok: ${v(quiz.emotional_intensity_ok)}
quiz_explicit_ok: ${v(quiz.explicit_ok)}
quiz_open_to_variety: ${v(quiz.open_to_variety)}
quiz_relationship_status: ${v(quiz.relationship_status)}`;
}

export interface ChapterNContext {
  chapterNumber: number;        // the chapter we are now writing (>= 2)
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

export function chapterNPrompt(ctx: ChapterNContext): string {
  const n = ctx.chapterNumber;
  const v = (x: string | undefined) => (x ?? "").trim() || "(unspecified)";

  return `You are writing chapter ${n} of a personalized, premium interactive romance story.

Your job is to:
1. Continue the story based on the selected option
2. Maintain full continuity with previous chapters
3. Update structured story state
4. Generate 3 strong next-step options for the upcoming chapter

The output must be clean, consistent, and easy to parse.

${FAILSAFE_BLOCK}

IMPORTANT INSTRUCTIONS:
- Return ONLY the labeled fields below.
- Use the exact labels exactly as written.
- Do not add any introduction, explanation, markdown, bullet list, or extra text.
- Do not skip any field.
- Each label must appear once.
- Put the value directly under its label.
- Maintain tone, genre, and heat level consistency.
- Write immersive second-person ("you") prose.
- Keep writing emotionally engaging and commercially readable.
- Respect existing world, character states, and dynamics.
- The selected option must clearly influence this chapter.
- The 3 next options must be clearly different and plausible.
- Keep structured fields concise but useful.
- Limit CHAPTER_TEXT to approximately 2000 words (max 2300).
- Never begin the chapter with the words "You don't". Vary the opening sentence structure each chapter.

STORY CONTEXT:

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

PREVIOUS CHAPTER:

Summary: ${v(ctx.prevChapter.summary)}
Mood: ${v(ctx.prevChapter.mood)}
Key event: ${v(ctx.prevChapter.keyEvent)}
Closure hook: ${v(ctx.prevChapter.closureHook)}

USER CHOICE:
${ctx.userChoiceText}

NEXT CHAPTER INTENT:

Goal: ${v(ctx.nextIntent.goal)}
Arc position: ${v(ctx.nextIntent.arcPosition)}
Tone hint: ${v(ctx.nextIntent.toneHint)}
Stakes: ${v(ctx.nextIntent.stakesLevel)}

OUTPUT FORMAT:
CHAPTER_TEXT:
[write the full chapter story]

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
