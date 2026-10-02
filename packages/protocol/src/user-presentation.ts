import { z } from 'zod';

export const questionReplyStart = '<send_user_message_question_reply>';
export const questionReplyEnd = '</send_user_message_question_reply>';
const replySchema = z.object({ questionItemId: z.string().min(1).max(400), question: z.string().max(8192), answer: z.string().max(8192) });
export type AsyncQuestionReply = z.infer<typeof replySchema>;
export type UserMessagePart = {type: 'text'; text: string} | {type: 'questionAnswer'; question: string; answer: string};

export function parseQuestionReplies(value: string): AsyncQuestionReply[] | null {
  const text = value.trim();
  if (text.length > 32000 || !text.startsWith(questionReplyStart) || !text.endsWith(questionReplyEnd)) return null;
  try {
    const data = JSON.parse(text.slice(questionReplyStart.length, -questionReplyEnd.length));
    const parsed = z.array(replySchema).min(1).max(20).safeParse(Array.isArray(data) ? data : [data]);
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

export function questionRepliesInText(value: string): AsyncQuestionReply[] {
  return [...value.matchAll(/<send_user_message_question_reply>[\s\S]*?<\/send_user_message_question_reply>/g)]
    .flatMap(match => parseQuestionReplies(match[0]) ?? []);
}

export function userPresentation(value: string): { body: string; files: string[]; parts?: UserMessagePart[] } {
  let body = value;
  let files: string[] = [];
  const wrapper = /^\s*(?:#{1,3}\s*)?Files mentioned by the user:\s*([\s\S]*?)\n\s*(?:#{1,3}\s*)?My request:\s*([\s\S]*)$/i.exec(body);
  if (wrapper) {
    files = [...wrapper[1]!.matchAll(/^\s*(?:#{1,4}\s*)?([^:\r\n\\/]+\.[a-z0-9]{1,12}):/gim)].map(match => match[1]!.trim()).slice(0, 40);
    if (files.length) body = wrapper[2]!.trim();
  }
  const context = /^\s*<in-app-browser-context\s+source=["']ambient-ui-state["']>\s*[\s\S]*?<\/in-app-browser-context>\s*(?:(?:#{1,3}\s*)?My request:\s*)?/i.exec(body);
  if (context) body = body.slice(context[0].length).trim();
  const parts: UserMessagePart[] = [];
  let offset = 0;
  for (const match of body.matchAll(/<send_user_message_question_reply>[\s\S]*?<\/send_user_message_question_reply>/g)) {
    const replies = parseQuestionReplies(match[0]);
    if (!replies) continue;
    if (match.index > offset) parts.push({type: 'text', text: body.slice(offset, match.index)});
    parts.push(...replies.map(reply => ({type: 'questionAnswer' as const, question: reply.question, answer: reply.answer})));
    offset = match.index + match[0].length;
  }
  if (parts.length) {
    if (offset < body.length) parts.push({type: 'text', text: body.slice(offset)});
    body = body.replace(/<send_user_message_question_reply>[\s\S]*?<\/send_user_message_question_reply>/g, wrapper => {
      const replies = parseQuestionReplies(wrapper);
      return replies ? replies.map(reply => `${reply.question}\n${reply.answer}`).join('\n\n') : wrapper;
    });
  }
  return { body, files, ...(parts.length ? {parts} : {}) };
}
