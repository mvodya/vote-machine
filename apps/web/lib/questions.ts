import {roomIdPattern} from './rooms';
import {isRecord, validCursor} from './voting-links';

export interface Choice {
  // Stable option ID, missing for a new option
  id?: string;
  // Plain source text, rendered as Markdown in a later stage
  content: string;
}
export interface QuestionInput {
  // Question source text
  content: string;
  // One answer or several answers
  choiceMode: 'single' | 'multiple';
  // Smallest allowed selection
  minChoices: number;
  // Largest allowed selection
  maxChoices: number;
  // Whether participants may see results
  shareResults: boolean;
  // When participant results become available
  publication: 'after_answer' | 'after_close';
  // Hide results from everyone until voting ends
  hideResultsUntilEnd: boolean;
  // Allow changes to an existing answer
  allowAnswerChange: boolean;
  // Hide respondent identity in results
  anonymous: boolean;
  // Allow a temporary skip without recording an answer
  allowSkip?: boolean;
  // Options in their display order
  choices: Choice[];
}
export interface QuestionSummary {
  // Stable question ID
  id: string;
  // Room that owns the question
  roomId: string;
  // Short source text for the list
  preview: string;
  // Current lifecycle state
  state: 'draft' | 'scheduled' | 'open' | 'closed';
  // Saved start settings and armed start instant
  startMode?: 'none' | 'absolute' | 'duration';
  startsAt?: string | null;
  startAfterSeconds?: number | null;
  scheduledAt?: string | null;
  // Only admin snapshots include live counters
  answerCount?: number;
  viewerCount?: number;
  // Optional deadline and close details from the database
  closesAt?: string | null;
  closedAt?: string | null;
  closedReason?: 'manual' | 'deadline' | null;
  // Saved deadline mode and relative duration
  deadlineMode?: 'none' | 'absolute' | 'duration';
  closeAfterSeconds?: number | null;
  openedAt?: string | null;
  // Stable key for equal creation times
  ordinal: string;
  // Creation time in UTC
  createdAt: string;
  // Version used to reject old edits
  revision: string;
  // Saved edit rule, set when the question first opens
  editLocked: boolean | null;
  // One answer or several answers
  choiceMode: 'single' | 'multiple';
  // Number of saved options
  choiceCount: number;
}
export interface Question extends QuestionInput, QuestionSummary {}

// Keep form limits equal to the database limits
export function validText(value: unknown, limit: number): value is string {
  return (
    typeof value === 'string' &&
    !value.includes('\0') &&
    [...value].length <= limit
  );
}
// Check the full draft before sending any part of it
export function isQuestionInput(value: unknown): value is QuestionInput {
  if (
    !isRecord(value) ||
    !validText(value.content, 20000) ||
    !Array.isArray(value.choices) ||
    value.choices.length > 100
  )
    return false;
  const ids = new Set<string>();
  for (const choice of value.choices) {
    if (!isRecord(choice) || !validText(choice.content, 5000)) return false;
    if (choice.id !== undefined) {
      if (
        typeof choice.id !== 'string' ||
        !roomIdPattern.test(choice.id) ||
        ids.has(choice.id)
      )
        return false;
      ids.add(choice.id);
    }
  }
  // Empty drafts still use a positive selection limit
  if (
    !Number.isInteger(value.minChoices) ||
    !Number.isInteger(value.maxChoices) ||
    Number(value.minChoices) < 1 ||
    Number(value.minChoices) > Number(value.maxChoices) ||
    Number(value.maxChoices) > Math.max(1, value.choices.length)
  )
    return false;
  if (value.choiceMode !== 'single' && value.choiceMode !== 'multiple')
    return false;
  if (
    value.choiceMode === 'single' &&
    (value.minChoices !== 1 || value.maxChoices !== 1)
  )
    return false;
  return (
    [
      'shareResults',
      'hideResultsUntilEnd',
      'allowAnswerChange',
      'anonymous',
    ].every((field) => typeof value[field] === 'boolean') &&
    (value.allowSkip === undefined || typeof value.allowSkip === 'boolean') &&
    (value.publication === 'after_answer' ||
      value.publication === 'after_close')
  );
}
// Use a time and stable key so deleting a page boundary does not break paging
export function validQuestionCursor(value: unknown): value is string {
  if (value === '0') return true;
  if (typeof value !== 'string') return false;
  const match =
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)~([1-9]\d{0,18})$/.exec(
      value,
    );
  return Boolean(
    match && Number.isFinite(Date.parse(match[1])) && validCursor(match[2]),
  );
}
// Check only the metadata needed in question lists
export function isQuestionSummary(value: unknown): value is QuestionSummary {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    roomIdPattern.test(value.id) &&
    typeof value.roomId === 'string' &&
    roomIdPattern.test(value.roomId) &&
    validText(value.preview, 240) &&
    ['draft', 'scheduled', 'open', 'closed'].includes(String(value.state)) &&
    (value.startMode === undefined ||
      ['none', 'absolute', 'duration'].includes(String(value.startMode))) &&
    [value.startsAt, value.scheduledAt].every(
      (at) =>
        at === undefined ||
        at === null ||
        (typeof at === 'string' && Number.isFinite(Date.parse(at))),
    ) &&
    (value.state !== 'scheduled' ||
      (typeof value.scheduledAt === 'string' &&
        value.startMode !== 'none' &&
        value.startMode !== undefined)) &&
    [value.answerCount, value.viewerCount].every(
      (count) =>
        count === undefined ||
        (Number.isSafeInteger(count) && Number(count) >= 0),
    ) &&
    validCursor(value.ordinal) &&
    value.ordinal !== '0' &&
    validCursor(value.revision) &&
    typeof value.createdAt === 'string' &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    (value.editLocked === null || typeof value.editLocked === 'boolean') &&
    (value.choiceMode === 'single' || value.choiceMode === 'multiple') &&
    Number.isInteger(value.choiceCount) &&
    Number(value.choiceCount) >= 0 &&
    Number(value.choiceCount) <= 100
  );
}
// A full editor reply must have stable option IDs
export function isQuestion(value: unknown): value is Question {
  return (
    isQuestionSummary(value) &&
    isQuestionInput(value) &&
    value.choiceCount === value.choices.length &&
    value.choices.every((choice) => typeof choice.id === 'string')
  );
}
// Use the same empty draft in every editor entry point
export function emptyQuestion(): QuestionInput {
  return {
    content: '',
    choiceMode: 'single',
    minChoices: 1,
    maxChoices: 1,
    shareResults: false,
    publication: 'after_close',
    hideResultsUntilEnd: false,
    allowAnswerChange: false,
    anonymous: false,
    allowSkip: false,
    choices: [{content: ''}, {content: ''}],
  };
}
// Strip extra fields before a draft crosses the browser boundary
export function questionInput(value: QuestionInput): QuestionInput {
  return {
    content: value.content,
    choiceMode: value.choiceMode,
    minChoices: value.minChoices,
    maxChoices: value.maxChoices,
    shareResults: value.shareResults,
    publication: value.publication,
    hideResultsUntilEnd: value.hideResultsUntilEnd,
    allowAnswerChange: value.allowAnswerChange,
    anonymous: value.anonymous,
    allowSkip: value.allowSkip ?? false,
    choices: value.choices.map((choice) => ({
      ...(choice.id ? {id: choice.id} : {}),
      content: choice.content,
    })),
  };
}
// Keep storage-only data out of editor replies
export function publicSummary(value: QuestionSummary): QuestionSummary {
  return {
    ...(value.startMode !== undefined
      ? {
          startMode: value.startMode,
          startsAt: value.startsAt,
          startAfterSeconds: value.startAfterSeconds,
          scheduledAt: value.scheduledAt,
        }
      : {}),
    ...(value.answerCount !== undefined
      ? {answerCount: value.answerCount, viewerCount: value.viewerCount}
      : {}),
    ...(value.closesAt !== undefined
      ? {
          closesAt: value.closesAt,
          closedAt: value.closedAt,
          closedReason: value.closedReason,
        }
      : {}),
    ...(value.deadlineMode !== undefined
      ? {
          deadlineMode: value.deadlineMode,
          closeAfterSeconds: value.closeAfterSeconds,
          openedAt: value.openedAt,
        }
      : {}),
    id: value.id,
    roomId: value.roomId,
    preview: value.preview,
    state: value.state,
    ordinal: value.ordinal,
    createdAt: value.createdAt,
    revision: value.revision,
    editLocked: value.editLocked,
    choiceMode: value.choiceMode,
    choiceCount: value.choiceCount,
  };
}
