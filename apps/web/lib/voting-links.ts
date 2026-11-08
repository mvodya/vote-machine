import {translate, type Locale} from './i18n/translate';
import {roomIdPattern, secretPattern, validName} from './rooms';

export type LinkMode = 'personal' | 'reusable' | 'registration';
export interface VotingLink {
  // Stable respondent ID, also used after a key change
  id: string;
  // Admin label for the respondent
  name: string;
  // Personal or shared link mode
  mode: LinkMode;
  // Stable order used for paging
  ordinal: string;
  // Version of the link data
  revision: string;
  // Count of stored sessions across all key generations
  sessionCount?: string;
  // Old runs stay private unless the admin allows their history
  allowRunHistory?: boolean;
  // Group registrations may need explicit approval
  requireModeration?: boolean;
  // Whether new access is blocked
  revoked: boolean;
}
export interface LinkPage {
  // Links on this page
  links: VotingLink[];
  // Cursor for the next older page
  nextCursor: string | null;
}
export interface ExportLink extends VotingLink {
  // Only active links may include a key
  token: string | null;
}
export interface Participant {
  // Room opened by this link
  roomId: string;
  // Current room name
  roomName: string;
  // Stable respondent ID
  linkId: string;
  // Respondent name
  name: string;
  // Link mode
  mode: LinkMode;
}

// Only JSON objects can contain named fields
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
// Keep cursor values inside PostgreSQL bigint
export function validCursor(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^(0|[1-9]\d{0,18})$/.test(value) &&
    BigInt(value) <= 9223372036854775807n
  );
}
// Check link data without exposing stored secrets
export function isVotingLink(value: unknown): value is VotingLink {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    roomIdPattern.test(value.id) &&
    validName(value.name) &&
    ['personal', 'reusable', 'registration'].includes(String(value.mode)) &&
    (value.requireModeration === undefined ||
      typeof value.requireModeration === 'boolean') &&
    validCursor(value.ordinal) &&
    value.ordinal !== '0' &&
    validCursor(value.revision) &&
    typeof value.revoked === 'boolean' &&
    (value.allowRunHistory === undefined ||
      typeof value.allowRunHistory === 'boolean') &&
    (value.sessionCount === undefined || validCursor(value.sessionCount))
  );
}
// Copy only fields allowed in normal admin lists
export function publicLink(value: VotingLink): VotingLink {
  return {
    id: value.id,
    name: value.name,
    mode: value.mode,
    ordinal: value.ordinal,
    revision: value.revision,
    revoked: value.revoked,
    ...(value.requireModeration !== undefined
      ? {requireModeration: value.requireModeration}
      : {}),
    ...(value.allowRunHistory !== undefined
      ? {allowRunHistory: value.allowRunHistory}
      : {}),
    ...(value.sessionCount !== undefined
      ? {sessionCount: value.sessionCount}
      : {}),
  };
}
// Check the room and link returned to a participant
export function isParticipant(value: unknown): value is Participant {
  return (
    isRecord(value) &&
    typeof value.roomId === 'string' &&
    roomIdPattern.test(value.roomId) &&
    typeof value.linkId === 'string' &&
    roomIdPattern.test(value.linkId) &&
    validName(value.name) &&
    validName(value.roomName) &&
    ['personal', 'reusable', 'registration'].includes(String(value.mode))
  );
}
// Build a link that does not put its key in server logs
export function votingUrl(origin: string, id: string, token: string) {
  return `${origin}/vote/${id}#key=${token}`;
}
// Prevent a CSV cell from being read as a spreadsheet formula
function csvCell(value: string) {
  const safe =
    /^[\s\uFEFF]*[=+\-@]/.test(value) || /^[\t\r\n]/.test(value)
      ? `'${value}`
      : value;
  return `"${safe.replaceAll('"', '""')}"`;
}
// Export every row, with no secret for revoked links
export function linksCsv(
  links: ExportLink[],
  origin: string,
  locale: Locale = 'ru',
) {
  const rows = [
    ['Имя', 'Режим', 'Статус', 'Ссылка'].map((label) =>
      translate(locale, label),
    ),
    ...links.map((link) => [
      link.name,
      translate(
        locale,
        link.mode === 'personal'
          ? 'Персональная'
          : link.mode === 'registration'
            ? 'С регистрацией'
            : 'Многоразовая',
      ),
      translate(locale, link.revoked ? 'Отозвана' : 'Действует'),
      !link.revoked && link.token && secretPattern.test(link.token)
        ? votingUrl(origin, link.id, link.token)
        : '',
    ]),
  ];
  return '\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}
// Keep one active link per line when copying the full list
export function linksText(links: ExportLink[], origin: string) {
  return links
    .filter(
      (link) => !link.revoked && link.token && secretPattern.test(link.token),
    )
    .map(
      (link) =>
        `${link.name.replace(/[\r\n\t]+/g, ' ')}\t${votingUrl(origin, link.id, link.token!)}`,
    )
    .join('\n');
}
