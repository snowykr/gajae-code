import { describe, expect, test } from "bun:test";
import {
	assignmentRequestsUltragoalRedTeam,
	parseExecutorExecutionMode,
	resolveUltragoalRedTeamActivation,
} from "../../src/task/ultragoal-redteam-activation";

describe("assignmentRequestsUltragoalRedTeam", () => {
	test("is off for empty or ordinary implementation assignments", () => {
		expect(assignmentRequestsUltragoalRedTeam(undefined)).toBe(false);
		expect(assignmentRequestsUltragoalRedTeam("")).toBe(false);
		expect(assignmentRequestsUltragoalRedTeam("   ")).toBe(false);
		expect(assignmentRequestsUltragoalRedTeam("Implement the retry helper and add unit tests.")).toBe(false);
		expect(
			assignmentRequestsUltragoalRedTeam("Fix blocking findings only, then leave verification to the parent."),
		).toBe(false);
	});

	test("does not activate on a bare executorQa token (incidental mention)", () => {
		// #2698: free-form assignment text that merely contains the field name
		// used to flip red-team mode via /executorQa/i.
		expect(assignmentRequestsUltragoalRedTeam("Document the executorQa JSON field names.")).toBe(false);
		expect(
			assignmentRequestsUltragoalRedTeam("Do not invent executorQa rows; the parent owns the quality gate."),
		).toBe(false);
		expect(
			assignmentRequestsUltragoalRedTeam("The quality gate schema includes architectReview and executorQa keys."),
		).toBe(false);
	});

	test("activates on explicit ultragoal completion QA / red-team labeling", () => {
		expect(assignmentRequestsUltragoalRedTeam("You are the Ultragoal completion QA lane. Break the change.")).toBe(
			true,
		);
		expect(assignmentRequestsUltragoalRedTeam("Ultragoal completion red-team: produce the adversarial matrix.")).toBe(
			true,
		);
		expect(assignmentRequestsUltragoalRedTeam("Run ultragoal completion red team against HEAD.")).toBe(true);
	});

	test("activates when assignment asks for executorQa red-team evidence", () => {
		expect(
			assignmentRequestsUltragoalRedTeam("Produce executorQa red-team evidence for the frozen change set."),
		).toBe(true);
		expect(
			assignmentRequestsUltragoalRedTeam("Fill the executorQa matrix with contractCoverage and adversarialCases."),
		).toBe(true);
		expect(
			assignmentRequestsUltragoalRedTeam("Return red-team evidence under the executorQa contract exactly."),
		).toBe(true);
	});
	test("requires affirmative executorQa red-team evidence instructions", () => {
		expect(
			assignmentRequestsUltragoalRedTeam("Produce executorQa red-team evidence for the frozen change set."),
		).toBe(true);
		expect(
			assignmentRequestsUltragoalRedTeam("Do not produce executorQa red-team evidence; implement the fix only."),
		).toBe(false);
	});
	test("does not activate when negation follows the activation phrase", () => {
		expect(
			assignmentRequestsUltragoalRedTeam("Ultragoal completion QA is not requested; implement the fix only."),
		).toBe(false);
		expect(
			assignmentRequestsUltragoalRedTeam("executorQa red-team evidence is not needed; implement the fix only."),
		).toBe(false);
	});
	test("does not activate on scoped no, no-need, or unnecessary wording", () => {
		expect(assignmentRequestsUltragoalRedTeam("No Ultragoal completion QA is needed.")).toBe(false);
		expect(assignmentRequestsUltragoalRedTeam("There is no need to produce executorQa red-team evidence.")).toBe(
			false,
		);
		expect(assignmentRequestsUltragoalRedTeam("Producing executorQa red-team evidence is unnecessary.")).toBe(false);
	});
	test("keeps affirmative need and necessary wording active", () => {
		expect(assignmentRequestsUltragoalRedTeam("Ultragoal completion QA is needed for the release.")).toBe(true);
		expect(assignmentRequestsUltragoalRedTeam("There is a need to produce executorQa red-team evidence.")).toBe(true);
		expect(assignmentRequestsUltragoalRedTeam("Ultragoal completion QA is necessary.")).toBe(true);
	});
	test("does not let an unrelated omission request override direct QA negation", () => {
		expect(
			assignmentRequestsUltragoalRedTeam("Do not skip unit tests, but do not run Ultragoal completion QA."),
		).toBe(false);
	});
	test("scopes unrelated safety negation away from explicit activation", () => {
		expect(assignmentRequestsUltragoalRedTeam("Run Ultragoal completion QA, but do not modify code.")).toBe(true);
		expect(assignmentRequestsUltragoalRedTeam("Do not run Ultragoal completion QA, but do not modify code.")).toBe(
			false,
		);
	});
	test("recognizes correlative not-only and not-just QA activation", () => {
		expect(
			assignmentRequestsUltragoalRedTeam("Not only run Ultragoal completion QA, but also verify the release."),
		).toBe(true);
		expect(
			assignmentRequestsUltragoalRedTeam("Not just produce executorQa red-team evidence, but verify the release."),
		).toBe(true);
		expect(assignmentRequestsUltragoalRedTeam("Do not run Ultragoal completion QA.")).toBe(false);
	});
	test("keeps negated omission requests affirmative", () => {
		expect(assignmentRequestsUltragoalRedTeam("Do not skip Ultragoal completion QA.")).toBe(true);
		expect(assignmentRequestsUltragoalRedTeam("Never omit the executor QA red-team lane.")).toBe(true);
	});
	test("treats explicit without-omission phrasing as affirmative", () => {
		expect(assignmentRequestsUltragoalRedTeam("Without skipping Ultragoal completion QA, verify the release.")).toBe(
			true,
		);
		expect(assignmentRequestsUltragoalRedTeam("Proceed without omitting executorQa red-team evidence.")).toBe(true);
	});
	test("keeps negated failure requests affirmative", () => {
		expect(assignmentRequestsUltragoalRedTeam("Do not forget to run Ultragoal completion QA.")).toBe(true);
		expect(assignmentRequestsUltragoalRedTeam("Never fail to produce executorQa red-team evidence.")).toBe(true);
		expect(assignmentRequestsUltragoalRedTeam("Do not neglect the executor QA red-team lane.")).toBe(true);
	});

	test("activates on Ultragoal skill spawn phrasing for the QA/red-team lane", () => {
		expect(
			assignmentRequestsUltragoalRedTeam("Delegate an executor QA/red-team lane to build and run the e2e suite."),
		).toBe(true);
		expect(
			assignmentRequestsUltragoalRedTeam("You are the executor red-team lane for this story's live CLI surface."),
		).toBe(true);
	});
});

describe("typed executionMode (#2698 / #2456)", () => {
	test("parseExecutorExecutionMode accepts aliases and rejects junk", () => {
		expect(parseExecutorExecutionMode("default")).toBe("default");
		expect(parseExecutorExecutionMode("implement")).toBe("default");
		expect(parseExecutorExecutionMode("ultragoal-red-team")).toBe("ultragoal-red-team");
		expect(parseExecutorExecutionMode("ultragoal_red_team")).toBe("ultragoal-red-team");
		expect(parseExecutorExecutionMode("red-team")).toBe("ultragoal-red-team");
		expect(parseExecutorExecutionMode("executor-qa")).toBe("ultragoal-red-team");
		expect(parseExecutorExecutionMode("")).toBeUndefined();
		expect(parseExecutorExecutionMode("banana")).toBeUndefined();
		expect(parseExecutorExecutionMode(42)).toBeUndefined();
	});

	test("typed ultragoal-red-team wins even when assignment is ordinary", () => {
		expect(
			resolveUltragoalRedTeamActivation({
				executionMode: "ultragoal-red-team",
				assignment: "Implement the helper and add tests.",
			}),
		).toBe(true);
	});

	test("typed default wins even when assignment would match heuristics", () => {
		expect(
			resolveUltragoalRedTeamActivation({
				executionMode: "default",
				assignment: "Produce executorQa red-team evidence for the frozen change set.",
			}),
		).toBe(false);
	});

	test("missing typed mode falls back to assignment heuristics", () => {
		expect(
			resolveUltragoalRedTeamActivation({
				assignment: "Document the executorQa JSON field names.",
			}),
		).toBe(false);
		expect(
			resolveUltragoalRedTeamActivation({
				assignment: "You are the Ultragoal completion QA lane.",
			}),
		).toBe(true);
	});

	test("unknown typed mode fails closed to heuristics (never invents on)", () => {
		expect(
			resolveUltragoalRedTeamActivation({
				executionMode: "banana",
				assignment: "ordinary work",
			}),
		).toBe(false);
	});
});
