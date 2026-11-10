import {isRecord} from './voting-links';
import {roomIdPattern} from './rooms';

export interface RoomReport {
  // Only the filtered totals belong in the public room summary
  roomName: string;
  shared: boolean;
  participants: number;
  answers: number;
  questions: {id: string; content: string; answers: number}[];
  sources: {kind: string; answers: number}[];
  // Link names are admin-only and exclude anonymous questions
  links: {
    id: string;
    name: string;
    mode: string;
    answers: number;
    participants: number;
  }[];
  // Export details are never included in the summary response
  sheets: {
    id: string;
    content: string;
    anonymous: boolean;
    total: number;
    options: {content: string; count: number}[];
  }[];
  people: {
    id: string;
    name: string | null;
    kind: string;
    groupName?: string;
    answers: {questionId: string; choices: string[]}[];
  }[];
}
const kinds = ['personal', 'reusable', 'admin_manual'];
// Keep counts precise before building charts or a workbook
function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
// Copy only fields allowed for this route and role
export function publicRoomReport(
  value: unknown,
  admin: boolean,
  exporting = false,
): RoomReport | null {
  if (
    !isRecord(value) ||
    typeof value.roomName !== 'string' ||
    typeof value.shared !== 'boolean' ||
    (!admin && !value.shared) ||
    !count(value.participants) ||
    !count(value.answers) ||
    !Array.isArray(value.questions) ||
    !Array.isArray(value.sources) ||
    !Array.isArray(value.links) ||
    !Array.isArray(value.sheets) ||
    !Array.isArray(value.people)
  )
    return null;
  const report: RoomReport = {
    roomName: value.roomName,
    shared: value.shared,
    participants: value.participants,
    answers: value.answers,
    questions: [],
    sources: [],
    links: [],
    sheets: [],
    people: [],
  };
  for (const q of value.questions) {
    if (
      !isRecord(q) ||
      typeof q.id !== 'string' ||
      !roomIdPattern.test(q.id) ||
      typeof q.content !== 'string' ||
      !count(q.answers)
    )
      return null;
    report.questions.push({id: q.id, content: q.content, answers: q.answers});
  }
  for (const source of value.sources) {
    if (
      !isRecord(source) ||
      !kinds.includes(String(source.kind)) ||
      !count(source.answers)
    )
      return null;
    report.sources.push({kind: String(source.kind), answers: source.answers});
  }
  if (admin)
    for (const link of value.links) {
      if (
        !isRecord(link) ||
        typeof link.id !== 'string' ||
        !roomIdPattern.test(link.id) ||
        typeof link.name !== 'string' ||
        !['personal', 'reusable', 'registration'].includes(String(link.mode)) ||
        !count(link.answers) ||
        !count(link.participants)
      )
        return null;
      report.links.push({
        id: link.id,
        name: link.name,
        mode: String(link.mode),
        answers: link.answers,
        participants: link.participants,
      });
    }
  if (exporting)
    for (const q of value.sheets) {
      if (
        !isRecord(q) ||
        typeof q.id !== 'string' ||
        !roomIdPattern.test(q.id) ||
        !report.questions.some((item) => item.id === q.id) ||
        typeof q.content !== 'string' ||
        typeof q.anonymous !== 'boolean' ||
        !count(q.total) ||
        !Array.isArray(q.options)
      )
        return null;
      const options = [];
      for (const option of q.options) {
        if (
          !isRecord(option) ||
          typeof option.content !== 'string' ||
          !count(option.count)
        )
          return null;
        options.push({content: option.content, count: option.count});
      }
      report.sheets.push({
        id: q.id,
        content: q.content,
        anonymous: q.anonymous,
        total: q.total,
        options,
      });
    }
  if (admin && exporting)
    for (const person of value.people) {
      if (
        !isRecord(person) ||
        typeof person.id !== 'string' ||
        !/^[prm]:[a-f0-9-]{36}$/.test(person.id) ||
        (person.name !== null && typeof person.name !== 'string') ||
        (person.groupName !== undefined &&
          (typeof person.groupName !== 'string' ||
            [...person.groupName].length > 200)) ||
        !kinds.includes(String(person.kind)) ||
        !Array.isArray(person.answers)
      )
        return null;
      const answers = [];
      for (const answer of person.answers) {
        if (
          !isRecord(answer) ||
          typeof answer.questionId !== 'string' ||
          !report.sheets.some(
            (q) => q.id === answer.questionId && !q.anonymous,
          ) ||
          !Array.isArray(answer.choices) ||
          !answer.choices.every((choice) => typeof choice === 'string')
        )
          return null;
        answers.push({
          questionId: answer.questionId,
          choices: answer.choices as string[],
        });
      }
      report.people.push({
        id: person.id,
        name: person.name as string | null,
        kind: String(person.kind),
        ...(typeof person.groupName === 'string'
          ? {groupName: person.groupName}
          : {}),
        answers,
      });
    }
  return report;
}
