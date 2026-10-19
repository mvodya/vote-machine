import {roomIdPattern} from './rooms';
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
export interface VotingRun {
  // Run identity and creation time
  id: string;
  createdAt: string;
}
export interface Journey {
  // Next armed question and whether any result is currently readable
  upcoming?: {id: string; preview: string; scheduledAt: string} | null;
  resultsAvailable?: boolean;
  // Current reusable run and recent runs of this session
  run?: VotingRun | null;
  runs?: VotingRun[];
  repeatAllowed?: boolean;
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
// Check session-owned run metadata before it reaches the browser
function isRun(value: unknown): value is VotingRun {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    roomIdPattern.test(value.id) &&
    typeof value.createdAt === 'string' &&
    Number.isFinite(Date.parse(value.createdAt))
  );
}
// Reject incomplete snapshots instead of showing mixed roles or versions
export function isJourney(value: unknown): value is Journey {
  if (
    !isRecord(value) ||
    (value.resultsAvailable !== undefined &&
      typeof value.resultsAvailable !== 'boolean') ||
    (value.upcoming !== undefined &&
      value.upcoming !== null &&
      (!isRecord(value.upcoming) ||
        typeof value.upcoming.id !== 'string' ||
        !roomIdPattern.test(value.upcoming.id) ||
        typeof value.upcoming.preview !== 'string' ||
        typeof value.upcoming.scheduledAt !== 'string' ||
        !Number.isFinite(Date.parse(value.upcoming.scheduledAt)))) ||
    (value.run !== undefined && value.run !== null && !isRun(value.run)) ||
    (value.runs !== undefined &&
      (!Array.isArray(value.runs) ||
        value.runs.length > 50 ||
        !value.runs.every(isRun))) ||
    (value.repeatAllowed !== undefined &&
      typeof value.repeatAllowed !== 'boolean') ||
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
// Never forward an admin electorate through participant snapshots
function participantInput(value: Question) {
  const input = questionInput(value);
  delete input.expectedLinkIds;
  return input;
}
// Keep storage data and other respondents out of browser snapshots
export function publicJourney(value: Journey): Journey {
  return {
    ...(value.resultsAvailable !== undefined
      ? {resultsAvailable: value.resultsAvailable}
      : {}),
    ...(value.upcoming !== undefined
      ? {
          upcoming: value.upcoming
            ? {
                id: value.upcoming.id,
                preview: value.upcoming.preview,
                scheduledAt: value.upcoming.scheduledAt,
              }
            : null,
        }
      : {}),
    ...(value.timeZone ? {timeZone: value.timeZone} : {}),
    ...(value.run !== undefined
      ? {
          run: value.run
            ? {id: value.run.id, createdAt: value.run.createdAt}
            : null,
          runs: (value.runs ?? []).map((run) => ({
            id: run.id,
            createdAt: run.createdAt,
          })),
          repeatAllowed: value.repeatAllowed === true,
        }
      : {}),
    questions: value.questions.map((item) => ({
      ...publicSummary(item),
      answered: item.answered,
      allowSkip: item.allowSkip,
      canChoose: item.canChoose,
    })),
    nextCursor: value.nextCursor,
    current: value.current
      ? {...publicSummary(value.current), ...participantInput(value.current)}
      : null,
    answer: value.answer ? publicAnswer(value.answer) : null,
    progress: {
      answered: value.progress.answered,
      total: value.progress.total,
      pending: value.progress.pending,
    },
  };
}
