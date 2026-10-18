import {validTimeZone} from './time';
import {isRecord} from './voting-links';
import {isAnswer, publicAnswer, type Answer} from './ballots';
import {
  isQuestion,
  isQuestionSummary,
  publicSummary,
  questionInput,
  validQuestionCursor,
  type Question,
  type QuestionSummary,
} from './questions';

export interface JourneyItem extends QuestionSummary {
  // Whether this link has already answered
  answered: boolean;
  // Whether this question permits a temporary skip
  allowSkip: boolean;
  // Whether earlier required questions allow navigation here
  canChoose: boolean;
}
export interface Journey {
  // Shared room zone for every participant
  timeZone?: string;
  // A metadata page for open questions and own history
  questions: JourneyItem[];
  // Next metadata page, independent of the active question
  nextCursor: string | null;
  // Active question content
  current: Question | null;
  // Only this link's own saved answer
  answer: Answer | null;
  // Progress of this link through currently open questions
  progress: {answered: number; total: number; pending: number};
}
// Reject incomplete snapshots instead of showing mixed roles or versions
export function isJourney(value: unknown): value is Journey {
  if (
    !isRecord(value) ||
    (value.timeZone !== undefined && !validTimeZone(value.timeZone)) ||
    !Array.isArray(value.questions) ||
    value.questions.length > 50 ||
    !value.questions.every(
      (item) =>
        isQuestionSummary(item) &&
        isRecord(item) &&
        typeof item.answered === 'boolean' &&
        typeof item.allowSkip === 'boolean' &&
        typeof item.canChoose === 'boolean',
    ) ||
    (value.nextCursor !== null && !validQuestionCursor(value.nextCursor)) ||
    (value.current !== null && !isQuestion(value.current)) ||
    (value.answer !== null && !isAnswer(value.answer)) ||
    !isRecord(value.progress)
  )
    return false;
  if (
    value.answer &&
    (!value.current || value.answer.questionId !== value.current.id)
  )
    return false;
  const {answered, total, pending} = value.progress;
  return (
    [answered, total, pending].every(
      (count) => Number.isSafeInteger(count) && Number(count) >= 0,
    ) && Number(answered) + Number(pending) === total
  );
}
// Keep storage data and other respondents out of browser snapshots
export function publicJourney(value: Journey): Journey {
  return {
    ...(value.timeZone ? {timeZone: value.timeZone} : {}),
    questions: value.questions.map((item) => ({
      ...publicSummary(item),
      answered: item.answered,
      allowSkip: item.allowSkip,
      canChoose: item.canChoose,
    })),
    nextCursor: value.nextCursor,
    current: value.current
      ? {...publicSummary(value.current), ...questionInput(value.current)}
      : null,
    answer: value.answer ? publicAnswer(value.answer) : null,
    progress: {
      answered: value.progress.answered,
      total: value.progress.total,
      pending: value.progress.pending,
    },
  };
}
