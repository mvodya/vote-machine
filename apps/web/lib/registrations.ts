import {isRecord, validCursor} from './voting-links';
import {roomIdPattern, validName} from './rooms';
import {isAccent} from './experience';

export interface RegisteredMember {
  // Stable person identity inside one group
  id: string;
  name: string;
  state: 'pending' | 'approved' | 'rejected';
  blocked: boolean;
  revision: string;
  // Only admin pages include ordering and current devices
  ordinal?: string;
  online?: number;
  questions?: {id: string; preview: string}[];
  // Only the member's own lobby includes call data
  callSequence?: string;
  calledAt?: string | null;
}
export interface RegistrationStatus {
  // The group label is separate from the person's name
  groupName: string;
  moderation: boolean;
  closed: boolean;
  accent: string;
  serverTime: string;
  member: RegisteredMember | null;
  // Private voting uses a scoped HttpOnly cookie set by the proxy
  votingId?: string;
}
// Ignore fields that do not belong to the current view
export function registrationMember(
  value: unknown,
  admin = false,
): RegisteredMember | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !roomIdPattern.test(value.id) ||
    !validName(value.name) ||
    typeof value.state !== 'string' ||
    !['pending', 'approved', 'rejected'].includes(value.state) ||
    typeof value.blocked !== 'boolean' ||
    !validCursor(value.revision)
  )
    return null;
  const result: RegisteredMember = {
    id: value.id,
    name: value.name,
    state: value.state as RegisteredMember['state'],
    blocked: value.blocked,
    revision: value.revision,
  };
  if (admin) {
    if (
      !validCursor(value.ordinal) ||
      !Number.isSafeInteger(value.online) ||
      Number(value.online) < 0 ||
      !Array.isArray(value.questions)
    )
      return null;
    const questions = [];
    for (const q of value.questions) {
      if (
        !isRecord(q) ||
        typeof q.id !== 'string' ||
        !roomIdPattern.test(q.id) ||
        typeof q.preview !== 'string'
      )
        return null;
      questions.push({id: q.id, preview: q.preview});
    }
    Object.assign(result, {
      ordinal: value.ordinal,
      online: value.online,
      questions,
    });
  } else {
    if (
      !validCursor(value.callSequence) ||
      (value.calledAt !== null &&
        (typeof value.calledAt !== 'string' ||
          !Number.isFinite(Date.parse(value.calledAt))))
    )
      return null;
    Object.assign(result, {
      callSequence: value.callSequence,
      calledAt: value.calledAt,
    });
  }
  return result;
}
// A pending or blocked browser must never receive a voting identity
export function registrationStatus(value: unknown): RegistrationStatus | null {
  if (
    !isRecord(value) ||
    !validName(value.groupName) ||
    typeof value.moderation !== 'boolean' ||
    typeof value.closed !== 'boolean' ||
    !isAccent(value.accent) ||
    typeof value.serverTime !== 'string' ||
    !Number.isFinite(Date.parse(value.serverTime))
  )
    return null;
  const member =
    value.member === null ? null : registrationMember(value.member);
  if (value.member !== null && !member) return null;
  const ready = member?.state === 'approved' && !member.blocked;
  if (
    ready &&
    (typeof value.votingId !== 'string' || !roomIdPattern.test(value.votingId))
  )
    return null;
  return {
    groupName: value.groupName,
    moderation: value.moderation,
    closed: value.closed,
    accent: value.accent,
    serverTime: value.serverTime,
    member,
    ...(ready ? {votingId: value.votingId as string} : {}),
  };
}
// Keep recovery credentials in the fragment so access logs do not contain them
export function registrationUrl(
  origin: string,
  group: string,
  member: string,
  token: string,
) {
  return `${origin}/vote/${group}#member=${member}&key=${token}`;
}
// Spreadsheet programs must treat every user-provided name as text
export function registrationsCsv(
  members: RegisteredMember[],
  t: (message: string) => string,
) {
  const cell = (value: unknown) => {
    const text = String(value ?? '');
    return `"${(/^[\s\uFEFF]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text) ? "'" + text : text).replaceAll('"', '""')}"`;
  };
  const states = {
    pending: 'Ожидает подтверждения',
    approved: 'Подтвержден',
    rejected: 'Отказано',
  };
  const rows = [
    [t('Имя'), t('Статус')],
    ...members.map((m) => [
      m.name,
      t(m.blocked ? 'Заблокирован' : states[m.state]),
    ]),
  ];
  return '\uFEFF' + rows.map((row) => row.map(cell).join(',')).join('\r\n');
}
