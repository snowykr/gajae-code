/**
 * Decide whether an executor assignment should inject the ultragoal red-team
 * prompt fragment.
 *
 * Preference order (parse, don't re-validate later):
 * 1. Explicit typed `executionMode` on the task / ExecutorOptions — authoritative.
 * 2. Assignment text heuristics — only explicit Ultragoal QA/red-team phrasing.
 *
 * Bare mentions of `executorQa` (docs, quality-gate field names, negative
 * instructions) must not flip the mode (#2698 / #2456).
 *
 * Mirrors `executor.md`:
 * "activates only when the assignment explicitly labels Executor as Ultragoal
 * completion QA/red-team or asks for `executorQa` red-team evidence."
 */

export const EXECUTOR_EXECUTION_MODES = ["default", "ultragoal-red-team"] as const;
export type ExecutorExecutionMode = (typeof EXECUTOR_EXECUTION_MODES)[number];

const ULTRAGOAL_COMPLETION_QA = /\bultragoal\s+completion\s+(?:qa|red[-\s]?team)\b/i;

/** `executorQa` within a short window of red-team / matrix / evidence framing. */
const EXECUTOR_QA_EVIDENCE =
	/\bexecutorQa\b[\s\S]{0,120}\b(?:red[-\s]?team|matrix|evidence)\b|\b(?:red[-\s]?team|matrix|evidence)\b[\s\S]{0,120}\bexecutorQa\b/i;

/** Common Ultragoal skill spawn phrasing: "executor QA/red-team lane". */
const EXECUTOR_QA_LANE = /\bexecutor\b[\s\S]{0,48}\b(?:qa|red[-\s]?team)\s+lane\b/i;

const NEGATION_NEARBY =
	/\b(?:do\s+not|don't|never|must\s+not|should\s+not|cannot|can't|not|no|without|avoid|refuse\s+to|decline\s+to)\b/i;
const NEGATED_ACTIVATION_AFTER =
	/\b(?:(?:(?:is|are|was|were)\s+)?(?:not|never)|(?:isn't|aren't|wasn't|weren't))\s+(?:requested|needed|wanted|required|necessary|allowed|available|applicable|run|produce|activate|perform)\b|\b(?:must|should|cannot|can't)\s+(?:not\s+)?(?:run|produce|activate|perform)\b|\bunnecessary\b/i;
/** Explicit omission-negation phrasing ("do not skip" or "without skipping") is affirmative. */
const NEGATED_OMISSION =
	/\b(?:do\s+not|don't|never|must\s+not|should\s+not)\s+(?:skip|omit|avoid|decline|refuse|forget|fail|neglect)\b|\bwithout\s+(?:skipping|omitting|avoiding|declining|refusing|forgetting|failing|neglecting)\b/i;
function hasScopedNegatedOmission(clause: string, matchStart: number): boolean {
	const beforeMatch = clause.slice(0, matchStart);
	const omissionMatcher = new RegExp(NEGATED_OMISSION.source, `${NEGATED_OMISSION.flags}g`);
	let omissionEnd = -1;
	for (const omission of beforeMatch.matchAll(omissionMatcher)) {
		const index = omission.index;
		if (index === undefined) continue;
		omissionEnd = index + omission[0].length;
	}

	if (omissionEnd < 0) return false;
	const requestTail = beforeMatch.slice(omissionEnd);
	return !NEGATION_NEARBY.test(requestTail) && !/\b(?:and|but|however|then|yet)\b/i.test(requestTail);
}
function getActivationScope(
	clause: string,
	matchStart: number,
	matchEnd: number,
): {
	start: number;
	end: number;
} {
	let start = 0;
	let end = clause.length;
	const separatorMatcher = /[,;]|\b(?:and|but|however|then|yet)\b/gi;

	for (const separator of clause.matchAll(separatorMatcher)) {
		const index = separator.index;
		if (index === undefined) continue;
		const separatorEnd = index + separator[0].length;
		if (separatorEnd <= matchStart) {
			start = separatorEnd;
		} else if (index >= matchEnd) {
			end = index;
			break;
		}
	}

	return { start, end };
}

function hasScopedNegation(clause: string, matchStart: number, matchEnd: number): boolean {
	const beforeMatch = clause.slice(0, matchStart).replace(/\bnot\s+(?:only|just)\b/gi, "");
	if (NEGATION_NEARBY.test(beforeMatch)) return true;
	return NEGATED_ACTIVATION_AFTER.test(clause.slice(matchEnd));
}

function hasAffirmativeActivation(text: string, pattern: RegExp): boolean {
	const matcher = new RegExp(pattern.source, `${pattern.flags}g`);
	for (const match of text.matchAll(matcher)) {
		const index = match.index;
		if (index === undefined) continue;

		const clauseStart = Math.max(
			text.lastIndexOf(".", index),
			text.lastIndexOf("!", index),
			text.lastIndexOf("?", index),
			text.lastIndexOf(";", index),
			text.lastIndexOf("\n", index),
		);
		const clauseEndOffset = text.slice(index).search(/[.!?;\n]/);
		const clauseEnd = clauseEndOffset < 0 ? text.length : index + clauseEndOffset;
		const clause = text.slice(clauseStart + 1, clauseEnd);
		const matchStart = index - clauseStart - 1;
		const scope = getActivationScope(clause, matchStart, matchStart + match[0].length);
		const scopedClause = clause.slice(scope.start, scope.end);
		const scopedMatchStart = matchStart - scope.start;
		const scopedMatchEnd = scopedMatchStart + match[0].length;
		if (
			!hasScopedNegation(scopedClause, scopedMatchStart, scopedMatchEnd) ||
			hasScopedNegatedOmission(scopedClause, scopedMatchStart)
		) {
			return true;
		}
	}
	return false;
}

export function isExecutorExecutionMode(value: unknown): value is ExecutorExecutionMode {
	return value === "default" || value === "ultragoal-red-team";
}

/**
 * Parse a caller-supplied mode. Unknown values fail closed to `undefined`
 * so the assignment heuristic (or default off) still applies — never invent on.
 */
export function parseExecutorExecutionMode(value: unknown): ExecutorExecutionMode | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase().replaceAll("_", "-");
	if (normalized === "default" || normalized === "ordinary" || normalized === "implement") {
		return "default";
	}
	if (
		normalized === "ultragoal-red-team" ||
		normalized === "ultragoal-redteam" ||
		normalized === "red-team" ||
		normalized === "redteam" ||
		normalized === "executor-qa"
	) {
		return "ultragoal-red-team";
	}
	return undefined;
}

export function assignmentRequestsUltragoalRedTeam(assignment: string | undefined): boolean {
	const text = assignment?.trim() ?? "";
	if (text.length === 0) return false;
	return (
		hasAffirmativeActivation(text, ULTRAGOAL_COMPLETION_QA) ||
		hasAffirmativeActivation(text, EXECUTOR_QA_EVIDENCE) ||
		hasAffirmativeActivation(text, EXECUTOR_QA_LANE)
	);
}

export interface ResolveUltragoalRedTeamArgs {
	readonly executionMode?: unknown;
	readonly assignment?: string;
}

/**
 * Final activation decision for the executor prompt fragment.
 * Typed mode wins; assignment text is a compatibility fallback only.
 */
export function resolveUltragoalRedTeamActivation(args: ResolveUltragoalRedTeamArgs): boolean {
	const mode = parseExecutorExecutionMode(args.executionMode);
	if (mode === "ultragoal-red-team") return true;
	if (mode === "default") return false;
	return assignmentRequestsUltragoalRedTeam(args.assignment);
}
