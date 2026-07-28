// Version-aware routing for quiz + story generation.
//
// Convention-based so adding a future quiz version (V3, V4, ...) requires:
//   1. Add quiz3_sessions table (or quizN_sessions for N > 2)
//   2. Add stories.quizN_session_id column
//   3. Deploy generate-chapter-vN edge function
//   4. Deploy submit-quizN edge function
//   5. Update QUIZ_TABLES + QUIZ_FK_COLUMN maps below with the new N
//
// NO changes to stripe-webhook, submit-choice, or create-subscription per version.
// They call getGenerateFunctionUrl() / getQuizTableName() / getStoriesFkColumn() and
// dispatch accordingly.
//
// V1 kept as an intentional exception (function is named "generate-chapter" without
// suffix, uses "quiz_sessions" without prefix, and stores FK in "session_id").
// Everything from V2 onward follows the -vN / quizN_ / quizN_session_id convention.

export type QuizVersion = 1 | 2; // extend with 3 | 4 as future versions ship

/**
 * Returns the Edge Function name for a given quiz version.
 * V1 is grandfathered ("generate-chapter" not "generate-chapter-v1").
 */
export function getGenerateFunctionName(version: QuizVersion): string {
  if (version === 1) return "generate-chapter";
  return `generate-chapter-v${version}`;
}

/**
 * Builds the full URL to invoke the version-appropriate generate-chapter function.
 * Requires SUPABASE_URL in the environment (always present in Edge Functions).
 */
export function getGenerateFunctionUrl(version: QuizVersion, supabaseUrl?: string): string {
  const base = supabaseUrl ?? Deno.env.get("SUPABASE_URL");
  if (!base) throw new Error("SUPABASE_URL not set");
  return `${base}/functions/v1/${getGenerateFunctionName(version)}`;
}

/**
 * The quiz_sessions-flavor table for a given version.
 * V1: "quiz_sessions" (grandfathered).
 * V2+: "quizN_sessions".
 */
export function getQuizTableName(version: QuizVersion): string {
  if (version === 1) return "quiz_sessions";
  return `quiz${version}_sessions`;
}

/**
 * The column on the stories table that FKs into the version's quiz table.
 * V1: "session_id" (grandfathered, references quiz_sessions.id).
 * V2+: "quizN_session_id" (references quizN_sessions.id).
 */
export function getStoriesFkColumn(version: QuizVersion): string {
  if (version === 1) return "session_id";
  return `quiz${version}_session_id`;
}

/**
 * Builds the stories.insert() row for a new story of a given version.
 * Callers should merge in the domain fields (lead_email, status, etc.) themselves.
 */
export function buildStoriesInsertRow(
  version: QuizVersion,
  quizSessionId: string,
): Record<string, unknown> {
  const fk = getStoriesFkColumn(version);
  return {
    quiz_version: version,
    [fk]: quizSessionId,
  };
}

/**
 * Reads the quiz session row for a story regardless of version.
 * Returns null on any lookup failure — caller decides whether to throw.
 */
export async function loadQuizSessionForStory(
  db: any,
  story: { quiz_version?: number; session_id?: string; quiz2_session_id?: string },
): Promise<Record<string, unknown> | null> {
  const version = (story.quiz_version ?? 1) as QuizVersion;
  const table = getQuizTableName(version);
  const fk = getStoriesFkColumn(version);
  const id = (story as any)[fk];
  if (!id) return null;
  const { data } = await db.from(table).select("*").eq("id", id).maybeSingle();
  return data ?? null;
}
