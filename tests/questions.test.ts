import { describe, expect, it } from "vitest";
import { inputQuestions } from "../packages/client-shared/src/questions.js";
import { normalizeRequests } from "../packages/codex-adapter/src/normalize.js";

describe("interactive input presentation", () => {
  it("preserves option descriptions, custom/secret flags and free-form questions", () => {
    const questions = [{id: "choice", header: "Choice", question: "Pick an approach", isOther: true, isSecret: false, options: [{label: "A", description: "First approach"}]}, {id: "text", question: "Describe your constraints", isSecret: true, options: null}];
    const [request] = normalizeRequests({requests: [{id: 42, method: "item/tool/requestUserInput", params: {turnId: "turn-A", questions, isBlocking: false, autoResolutionMs: null}}]});
    expect(request).toMatchObject({kind: "userInput", respondable: true, details: {isBlocking: false, autoResolutionMs: null}});
    expect(inputQuestions(request!.details)).toMatchObject([{options: [{label: "A", description: "First approach"}], isOther: true}, {options: [], isSecret: true}]);
  });
  it("disables malformed, ambiguous, oversized or empty question sets", () => {
    const q = {id: "choice", question: "Choose"};
    for (const questions of [[], [q, q], [{question: "Missing ID"}], [{...q, options: [{label: "A"}, {label: "A"}]}], [{...q, question: "x".repeat(8193)}], ["text-only"]]) expect(inputQuestions({questions})).toEqual([]);
  });
  it("does not recreate resolved questions from retained desktop state", () => {
    expect(normalizeRequests({requests: [{id: 42, completed: true, method: "item/tool/requestUserInput", params: {turnId: "turn-A"}}]})).toEqual([]);
  });
});
