import {roomIdPattern} from './rooms';
import {isRecord, validCursor} from './voting-links';

export interface Answer {
  // Stable ballot identity
  id?: string;
  // Another session may know the answer exists without seeing its choice
  hidden?: boolean;
  // Question answered by this link
  questionId: string;
  // Version used for safe answer changes
  revision: string;
  // Selected stable option IDs
  choices: string[];
  // Database times in UTC
  createdAt?: string;
  updatedAt?: string;
}
// Check only the owner's answer, with no respondent identity fields
export function isAnswer(value: unknown): value is Answer {
  if (
    !isRecord(value) ||
    typeof value.questionId !== 'string' ||
    !roomIdPattern.test(value.questionId) ||
    !validCursor(value.revision) ||
    !Array.isArray(value.choices)
  )
    return false;
  if (value.hidden === true)
    return (
      value.choices.length === 0 &&
      value.id === undefined &&
      value.createdAt === undefined &&
      value.updatedAt === undefined
    );
  return (
    value.hidden === undefined &&
    typeof value.id === 'string' &&
    roomIdPattern.test(value.id) &&
    value.choices.length <= 100 &&
    value.choices.every(
      (id) => typeof id === 'string' && roomIdPattern.test(id),
    ) &&
    new Set(value.choices).size === value.choices.length &&
    typeof value.createdAt === 'string' &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    typeof value.updatedAt === 'string' &&
    Number.isFinite(Date.parse(value.updatedAt))
  );
}
// Drop any future storage-only fields at the web boundary
export function publicAnswer(value: Answer): Answer {
  if (value.hidden)
    return {
      questionId: value.questionId,
      revision: value.revision,
      choices: [],
      hidden: true,
    };
  return {
    id: value.id,
    questionId: value.questionId,
    revision: value.revision,
    choices: value.choices,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}
