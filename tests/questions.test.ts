import { describe, expect, it } from "vitest";
import { inputQuestions } from "../packages/client-shared/src/questions.js";
import { normalizeRequests } from "../packages/codex-adapter/src/normalize.js";
import { normalizeThread } from '../packages/codex-adapter/src/normalize.js';
import { asyncQuestionAnswer } from '../packages/codex-adapter/src/async-input.js';
import { parseQuestionReplies, userPresentation } from '../packages/protocol/src/user-presentation.js';

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

  it('recognizes real async message questions without an App Server pending request', () => {
    const state = {id: 'thread-test', threadRuntimeStatus: {type: 'active'}, requests: [], turns: [{id: 'turn-A', status: 'inProgress', items: [{id: 'call-question', type: 'agentMessage', delivery: 'async', text: 'A question with options', questions: [{title: 'Which approach?', options: ['A', 'B']}, {title: 'Any constraints?', options: null}]}]}]};
    const normalized = normalizeThread(state, 0);
    expect(normalized.requests).toHaveLength(1);
    const request = normalized.requests[0]!;
    expect(request).toMatchObject({id: 'async:call-question', turnId: 'turn-A', respondable: true, details: {source: 'asyncMessage'}});
    expect(normalized.turns[0]!.items[0]!.questionRequestId).toBe(request.id);
    expect(inputQuestions(request.details)).toMatchObject([{id: '0', question: 'Which approach?', isOther: true, options: [{label: 'A'}, {label: 'B'}]}, {id: '1', question: 'Any constraints?', options: []}]);
    const text = asyncQuestionAnswer(request, {'0': {answers: ['B']}, '1': {answers: ['Keep existing files']}})!;
    expect(parseQuestionReplies(text)).toEqual([{questionItemId: JSON.stringify(['request_user_input_async', 'call-question', 0]), question: 'Which approach?', answer: 'B'}, {questionItemId: JSON.stringify(['request_user_input_async', 'call-question', 1]), question: 'Any constraints?', answer: 'Keep existing files'}]);
    expect(asyncQuestionAnswer(request, {'0': {answers: ['A']}})).toBeNull();
    expect(asyncQuestionAnswer(request, {'0': {answers: ['A', 'B']}, '1': {answers: ['Detail']}})).toBeNull();
    expect(userPresentation(text).body).toBe('Which approach?\nB\n\nAny constraints?\nKeep existing files');
    expect(userPresentation(text + '\nPlease retain this note.').body).toBe('Which approach?\nB\n\nAny constraints?\nKeep existing files\nPlease retain this note.');
    const reply = {id: 'reply', type: 'steeringUserMessage', status: 'pending', input: [{type: 'text', text: text + '\nPlease retain this note.'}]};
    state.turns[0]!.items.push(reply as never);
    expect(normalizeRequests(state)).toHaveLength(1);
    reply.status = 'accepted';
    expect(normalizeRequests(state)).toEqual([]);
    state.turns[0]!.items.pop(); state.turns[0]!.status = 'completed';
    expect(normalizeRequests(state)).toEqual([]);
  });

  it('decodes long reply envelopes before truncating snapshot text', () => {
    const text = '<send_user_message_question_reply>\n' + JSON.stringify([{questionItemId: '["request_user_input_async","call-question",0]', question: 'Constraints?', answer: 'x'.repeat(7000)}]) + '\n</send_user_message_question_reply>\nAdditional note.';
    const normalized = normalizeThread({id: 'thread-test', threadRuntimeStatus: {type: 'idle'}, turns: [{id: 'turn-A', status: 'completed', items: [{id: 'reply', type: 'userMessage', content: [{type: 'text', text}]}]}]}, 0);
    expect(normalized.turns[0]!.items[0]).toMatchObject({text: ('Constraints?\n' + 'x'.repeat(7000)).slice(0, 4096), truncated: true});
    expect(normalized.turns[0]!.items[0]!.text).not.toContain('send_user_message_question_reply');
  });

  it('keeps only unanswered async questions and ignores malformed or foreign replies', () => {
    const question = {id: 'call-question', type: 'agentMessage', questions: [{title: 'First?', options: ['A']}, {title: 'Second?', options: null}]};
    const text = '<send_user_message_question_reply>\n' + JSON.stringify([{questionItemId: JSON.stringify(['request_user_input_async', question.id, 0]), question: 'First?', answer: 'A'}]) + '\n</send_user_message_question_reply>';
    const state = {turns: [{id: 'turn-A', status: 'inProgress', items: [question, {type: 'userMessage', content: [{type: 'text', text}]}]}]};
    expect(inputQuestions(normalizeRequests(state)[0]!.details)).toMatchObject([{id: '1', question: 'Second?'}]);
    expect(parseQuestionReplies('<send_user_message_question_reply>invalid</send_user_message_question_reply>')).toBeNull();
    expect(userPresentation('<send_user_message_question_reply>invalid</send_user_message_question_reply>').body).toContain('invalid');
    expect(normalizeRequests({turns: [{id: 'turn-A', status: 'inProgress', items: [{...question, questions: [{title: 'Pick', options: ['A', 'A']}]}]}]})).toEqual([]);
  });
});
