import {translate, type Locale} from './i18n/translate';
import {isRecord, validCursor} from './voting-links';
import {roomIdPattern, validName} from './rooms';
export interface ResultOption {
  // Counts use ballots as the percentage base
  id: string;
  content: string;
  count: number;
  percent: number;
}
export interface PersonResult {
  // Only non-anonymous admin views have these fields
  id: string;
  linkId: string | null;
  name: string | null;
  source: string;
  // Registration group labels are admin-only and never appear in anonymous results
  groupName?: string;
  choices: string[];
}
export interface VoteResult {
  // A hidden result carries only identity and availability
  id: string;
  available: boolean;
  closesAt?: string | null;
  scheduledAt?: string | null;
  answerCount?: number;
  roomId?: string;
  content?: string;
  state?: string;
  anonymous?: boolean;
  choiceMode?: string;
  total?: number;
  options?: ResultOption[];
  sources?: Record<string, number>;
  people?: PersonResult[];
  nextPeopleCursor?: string | null;
}
export interface ResultPage {
  // This list never carries vote counts
  questions: {id: string; content: string; state: string; available: boolean}[];
  nextCursor: string | null;
}
const sources = [
  'personal',
  'admin_personal',
  'reusable',
  'registration',
  'admin_manual',
];
// Reject unsafe counts and unknown identifiers
function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
// Build a new public object rather than forwarding storage fields
export function resultPage(value: unknown): ResultPage | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.questions) ||
    value.questions.length > 50 ||
    (value.nextCursor !== null && !validCursor(value.nextCursor))
  )
    return null;
  const questions = [];
  for (const q of value.questions) {
    if (
      !isRecord(q) ||
      typeof q.id !== 'string' ||
      !roomIdPattern.test(q.id) ||
      typeof q.content !== 'string' ||
      !['draft', 'scheduled', 'open', 'closed'].includes(String(q.state)) ||
      typeof q.available !== 'boolean'
    )
      return null;
    questions.push({
      id: q.id,
      content: q.content,
      state: String(q.state),
      available: q.available,
    });
  }
  return {questions, nextCursor: value.nextCursor as string | null};
}
// Remove identity data from participant and anonymous result payloads
export function publicResult(
  value: unknown,
  admin: boolean,
  projector = false,
): VoteResult | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !roomIdPattern.test(value.id) ||
    typeof value.available !== 'boolean'
  )
    return null;
  if (!value.available)
    return {
      id: value.id,
      available: false,
      ...(projector &&
      typeof value.content === 'string' &&
      ['draft', 'scheduled', 'open', 'closed'].includes(String(value.state))
        ? {
            content: value.content,
            state: String(value.state),
            closesAt:
              typeof value.closesAt === 'string' ? value.closesAt : null,
            scheduledAt:
              typeof value.scheduledAt === 'string' ? value.scheduledAt : null,
            answerCount: count(value.answerCount)
              ? value.answerCount
              : undefined,
          }
        : {}),
    };
  if (
    typeof value.roomId !== 'string' ||
    !roomIdPattern.test(value.roomId) ||
    typeof value.content !== 'string' ||
    !['draft', 'scheduled', 'open', 'closed'].includes(String(value.state)) ||
    typeof value.anonymous !== 'boolean' ||
    !['single', 'multiple'].includes(String(value.choiceMode)) ||
    !count(value.total) ||
    !Array.isArray(value.options) ||
    value.options.length > 100
  )
    return null;
  const options: ResultOption[] = [];
  for (const item of value.options) {
    if (
      !isRecord(item) ||
      typeof item.id !== 'string' ||
      !roomIdPattern.test(item.id) ||
      typeof item.content !== 'string' ||
      !count(item.count) ||
      item.count > value.total ||
      typeof item.percent !== 'number' ||
      !Number.isFinite(item.percent) ||
      item.percent < 0 ||
      item.percent > 100
    )
      return null;
    options.push({
      id: item.id,
      content: item.content,
      count: item.count,
      percent: item.percent,
    });
  }
  const result: VoteResult = {
    id: value.id,
    available: true,
    ...(projector
      ? {
          closesAt: typeof value.closesAt === 'string' ? value.closesAt : null,
          scheduledAt:
            typeof value.scheduledAt === 'string' ? value.scheduledAt : null,
        }
      : {}),
    roomId: value.roomId,
    content: value.content,
    state: String(value.state),
    anonymous: value.anonymous,
    choiceMode: String(value.choiceMode),
    total: value.total,
    options,
  };
  if (admin && !projector) {
    if (
      !isRecord(value.sources) ||
      !sources.every(
        (key) =>
          (['admin_personal', 'registration'].includes(key) &&
            (value.sources as Record<string, unknown>)[key] === undefined) ||
          count((value.sources as Record<string, unknown>)[key]),
      )
    )
      return null;
    result.sources = Object.fromEntries(
      sources.map((key) => [
        key,
        (value.sources as Record<string, number>)[key] ?? 0,
      ]),
    );
    result.sources.personal += result.sources.admin_personal;
    delete result.sources.admin_personal;
    if (!value.anonymous) {
      if (
        !Array.isArray(value.people) ||
        value.people.length > 50 ||
        (value.nextPeopleCursor !== null &&
          (typeof value.nextPeopleCursor !== 'string' ||
            !roomIdPattern.test(value.nextPeopleCursor)))
      )
        return null;
      result.people = [];
      for (const person of value.people) {
        if (!isRecord(person)) return null;
        // Older database readers use null for a submitted empty answer
        const choices = person.choices === null ? [] : person.choices;
        if (
          typeof person.id !== 'string' ||
          !roomIdPattern.test(person.id) ||
          (person.linkId !== null &&
            (typeof person.linkId !== 'string' ||
              !roomIdPattern.test(person.linkId))) ||
          (person.name !== null && typeof person.name !== 'string') ||
          (person.groupName !== undefined && !validName(person.groupName)) ||
          !sources.includes(String(person.source)) ||
          !Array.isArray(choices) ||
          !choices.every(
            (id) =>
              typeof id === 'string' &&
              options.some((option) => option.id === id),
          )
        )
          return null;
        result.people.push({
          id: person.id,
          linkId: person.linkId as string | null,
          name: person.name as string | null,
          source: String(person.source),
          ...(typeof person.groupName === 'string'
            ? {groupName: person.groupName}
            : {}),
          choices,
        });
      }
      result.nextPeopleCursor = value.nextPeopleCursor as string | null;
    }
  }
  return result;
}
// Protect user text when a CSV is opened by a spreadsheet app
function csvCell(value: unknown) {
  const text = String(value ?? '');
  return `"${(/^[\s]*[=+@-]/.test(text) ? "'" : '') + text.replaceAll('"', '""')}"`;
}
// Export only the already filtered aggregate view
export function resultCsv(result: VoteResult, locale: Locale = 'ru') {
  if (!result.available) return null;
  return (
    '\uFEFF' +
    [
      ['Вариант', 'Голоса', 'Процент'].map((label) => translate(locale, label)),
      ...(result.options ?? []).map((option) => [
        option.content,
        option.count,
        option.percent,
      ]),
    ]
      .map((row) => row.map(csvCell).join(','))
      .join('\r\n')
  );
}
