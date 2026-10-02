import { asyncQuestionsSchema } from '../../protocol/src/async-input.js';
import { questionRepliesInText, questionReplyEnd, questionReplyStart } from '../../protocol/src/user-presentation.js';
import { jsonBytes } from '../../protocol/src/index.js';
import type { InteractiveRequest } from '../../protocol/src/index.js';

type Raw = Record<string, unknown>;
const record = (value: unknown): Raw => value && typeof value === 'object' && !Array.isArray(value) ? value as Raw : {};

export function asyncQuestionRequestId(item: Raw): string | null {
  if (item.type !== 'agentMessage' || typeof item.id !== 'string' || !item.id.length || item.id.length > 154) return null;
  return asyncQuestionsSchema.safeParse(item.questions).success && jsonBytes(item.questions) <= 12000 ? `async:${item.id}` : null;
}

/** Desktop async questions live on messages, not in pending App Server RPC requests. */
export function asyncInputRequests(turns: Raw[]): InteractiveRequest[] {
  const requests: InteractiveRequest[] = [];
  for (const turn of turns) {
    const turnId = turn.turnId ?? turn.id;
    if (turn.status !== 'inProgress' || typeof turnId !== 'string' || !turnId.length || turnId.length > 160) continue;
    const items = Array.isArray(turn.items) ? turn.items.map(record) : [];
    const answered = new Map<string, number>();
    items.forEach((item, index) => {
      if (item.type !== 'userMessage' && (item.type !== 'steeringUserMessage' || item.status !== 'accepted')) return;
      const input = item.type === 'userMessage' ? item.content : item.input;
      if (!Array.isArray(input)) return;
      for (const part of input.map(record)) {
        if (part.type !== 'text' || typeof part.text !== 'string') continue;
        for (const reply of questionRepliesInText(part.text)) answered.set(reply.questionItemId, index);
      }
    });
    items.forEach((item, itemIndex) => {
      const id = asyncQuestionRequestId(item);
      if (!id || requests.length >= 40) return;
      const questions = asyncQuestionsSchema.parse(item.questions).flatMap((question, index) => {
        const key = JSON.stringify(['request_user_input_async', item.id, index]);
        if ((answered.get(key) ?? -1) > itemIndex) return [];
        return [{ id: String(index), header: '', question: question.title, isOther: true, isSecret: false, options: (question.options ?? []).map(label => ({ label, description: '' })) }];
      });
      if (!questions.length) return;
      const details = { source: 'asyncMessage', sourceItemId: item.id, questions, isBlocking: false };
      const detailsTruncated = jsonBytes(details) > 16384;
      requests.push({ id, kind: 'userInput', turnId, details: detailsTruncated ? {} : details, detailsTruncated, respondable: !detailsTruncated });
    });
  }
  return requests;
}

export function asyncQuestionAnswer(request: InteractiveRequest, answers: Record<string, { answers: string[] }>): string | null {
  const questions = Array.isArray(request.details.questions) ? request.details.questions.map(record) : [];
  const ids = Object.keys(answers);
  if (!questions.length || !ids.length || ids.some(id => !questions.some(question => question.id === id))) return null;
  const replies = [];
  for (const question of questions) {
    if (!Object.hasOwn(answers, String(question.id))) continue;
    const answer = Object.hasOwn(answers, String(question.id)) ? answers[String(question.id)]?.answers : undefined;
    if (!answer || answer.length !== 1 || !answer[0]?.trim() || answer[0].length > 8192) return null;
    replies.push({ questionItemId: JSON.stringify(['request_user_input_async', request.details.sourceItemId, Number(question.id)]), question: question.question, answer: answer[0] });
  }
  const text = `${questionReplyStart}\n${JSON.stringify(replies)}\n${questionReplyEnd}`;
  return text.length <= 32000 ? text : null;
}
