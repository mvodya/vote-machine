import {expect, it, vi} from 'vitest';
import {resultsProxy} from '../lib/results-proxy';
import ExcelJS from 'exceljs';
import {publicRoomReport, type RoomReport} from '../lib/room-report';
import {resultsWorkbook} from '../lib/server/results-workbook';
const id = 'a96c3a49-0198-4545-8dce-44b70c86494d';
const report: RoomReport = {
  roomName: '=Room',
  shared: true,
  participants: 1,
  answers: 1,
  questions: [{id, content: 'Question / [title]', answers: 1}],
  sources: [{kind: 'personal', answers: 1}],
  links: [
    {id, name: '=Private name', mode: 'personal', participants: 1, answers: 1},
  ],
  sheets: [
    {
      id,
      content: 'Question / [title]',
      anonymous: false,
      total: 1,
      options: [{content: '=HYPERLINK("bad")', count: 1}],
    },
  ],
  people: [
    {
      id: `p:${id}`,
      name: '=Private name',
      kind: 'personal',
      answers: [{questionId: id, choices: ['=HYPERLINK("bad")']}],
    },
  ],
};
it('copies only role-safe fields and keeps export rows out of the JSON summary', () => {
  const participant = publicRoomReport({...report, secret: 'never'}, false)!;
  expect(participant.links).toEqual([]);
  expect(participant.people).toEqual([]);
  expect(participant.sheets).toEqual([]);
  expect(JSON.stringify(participant)).not.toContain('Private name');
  expect(publicRoomReport({...report, shared: false}, false)).toBeNull();
  expect(publicRoomReport({...report, answers: -1}, true)).toBeNull();
});
it('refuses anonymous or missing question associations in an individual export', () => {
  expect(
    publicRoomReport(
      {...report, sheets: [{...report.sheets[0], anonymous: true}]},
      true,
      true,
    ),
  ).toBeNull();
  expect(publicRoomReport({...report, sheets: []}, true, true)).toBeNull();
});
it('writes real XLSX sheets with plain text cells and no anonymous session columns', async () => {
  const book = new ExcelJS.Workbook();
  const data = await resultsWorkbook(
    publicRoomReport(report, true, true)!,
    true,
  );
  await book.xlsx.load(new Uint8Array(data).buffer);
  expect(book.worksheets).toHaveLength(3);
  expect(book.worksheets[1].name).not.toMatch(/[\[\]/*?:]/);
  expect(book.worksheets[1].getCell('A4').value).toBe('=HYPERLINK("bad")');
  expect(book.worksheets[1].getCell('A4').type).toBe(ExcelJS.ValueType.String);
  expect(book.getWorksheet('По участникам')!.getCell('B2').value).toBe(
    '=Private name',
  );
  const anonymous = publicRoomReport(
    {...report, sheets: [{...report.sheets[0], anonymous: true}], people: []},
    true,
    true,
  )!;
  const anonBook = new ExcelJS.Workbook();
  await anonBook.xlsx.load(
    new Uint8Array(await resultsWorkbook(anonymous, true)).buffer,
  );
  expect(anonBook.getWorksheet('По участникам')!.columnCount).toBe(3);
  expect(anonBook.getWorksheet('По участникам')!.rowCount).toBe(1);
});
it('omits the participant worksheet and link names from the respondent workbook', async () => {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(
    new Uint8Array(
      await resultsWorkbook(publicRoomReport(report, false, true)!, false),
    ).buffer,
  );
  expect(book.worksheets).toHaveLength(2);
  expect(book.getWorksheet('По участникам')).toBeUndefined();
  const rows: unknown[] = [];
  book.worksheets.forEach((sheet) =>
    sheet.eachRow((row) => rows.push(row.values)),
  );
  expect(JSON.stringify(rows)).not.toContain('Private name');
});
it('keeps long Unicode selections in continuation rows without cutting off text', async () => {
  const text = '🌍'.repeat(20000);
  const long = {
    ...report,
    people: [
      {...report.people[0], answers: [{questionId: id, choices: [text]}]},
    ],
  };
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(
    new Uint8Array(await resultsWorkbook(long, true)).buffer,
  );
  const sheet = book.getWorksheet('По участникам')!;
  expect(sheet.rowCount).toBe(3);
  expect(
    String(sheet.getCell('D2').value) + String(sheet.getCell('D3').value),
  ).toBe(text);
  expect(sheet.getCell('A3').value).toBe(report.people[0].id);
});
it('requires a scoped cookie and strips private fields at the HTTP boundary', async () => {
  const upstream = vi.fn<typeof fetch>(async () => Response.json({report}));
  vi.stubGlobal('fetch', upstream);
  expect(
    (
      await resultsProxy(
        new Request(`https://vote.test/api/vote/${id}/results?view=summary`),
        id,
        false,
      )
    ).status,
  ).toBe(401);
  expect(upstream).not.toHaveBeenCalled();
  const request = new Request(
    `https://vote.test/api/vote/${id}/results?view=summary`,
    {headers: {Cookie: `vm_vote_${id}=${'a'.repeat(64)}`}},
  );
  const response = await resultsProxy(request, id, false);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toContain('no-store');
  expect(await response.text()).not.toContain('Private name');
  expect(String(upstream.mock.calls[0][0])).toContain('view=summary');
});
it('keeps revoked and disabled reports unavailable to exports', async () => {
  const request = new Request(
    `https://vote.test/api/vote/${id}/results?format=xlsx`,
    {headers: {Cookie: `vm_vote_${id}=${'a'.repeat(64)}`}},
  );
  for (const status of [401, 403]) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({error: 'Private upstream details'}, {status}),
      ),
    );
    const response = await resultsProxy(request, id, false);
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain('Private upstream details');
  }
});

it('localizes workbook labels without translating room names or question content', async () => {
  const book = new ExcelJS.Workbook();
  const localized = {
    ...report,
    roomName: 'Настройки',
    sheets: [{...report.sheets[0], content: 'Ответы'}],
  };
  await book.xlsx.load(
    new Uint8Array(await resultsWorkbook(localized, true, 'en')).buffer,
  );
  expect(book.worksheets[0].name).toBe('Summary');
  expect(book.worksheets[0].getCell('A1').value).toBe('Room');
  expect(book.worksheets[0].getCell('B1').value).toBe('Настройки');
  expect(book.worksheets[1].getCell('B1').value).toBe('Ответы');
  expect(book.worksheets.at(-1)!.name).toBe('By participant');
});

it('accepts the registration source in admin and shared room summaries', () => {
  const data = {...report, sources: [{kind: 'registration', answers: 1}]};
  expect(publicRoomReport(data, true)!.sources).toEqual(data.sources);
  expect(publicRoomReport(data, false)!.sources).toEqual(data.sources);
});
