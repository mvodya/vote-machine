import {translate, type Locale} from '../i18n/translate';
import ExcelJS from 'exceljs';
import type {RoomReport} from '../room-report';
import {markdownSummary} from '../markdown';

const kinds: Record<string, string> = {
  personal: 'Персональная ссылка',
  reusable: 'Многоразовая ссылка',
  registration: 'Ссылки с регистрацией',
  admin_manual: 'Ручной ввод',
};

// Build a workbook only from an already filtered server snapshot
export async function resultsWorkbook(
  report: RoomReport,
  admin: boolean,
  locale: Locale = 'ru',
) {
  const t = (message: string) => translate(locale, message);
  const book = new ExcelJS.Workbook();
  book.creator = 'vote.machine.';
  book.created = new Date();
  const names = new Set<string>();
  // Excel names must be short, unique and free of special characters
  function sheet(
    title: string,
    rows: (string | number)[][],
    headerRow = 1,
    filter = false,
  ) {
    const base =
      title
        .replace(/[\\/*?:\[\]\x00-\x1f]/g, ' ')
        .replace(/^'+|'+$/g, '')
        .trim()
        .slice(0, 28) || t('Вопрос');
    let name = base;
    let suffix = 1;
    while (names.has(name.toLowerCase()))
      name = `${base.slice(0, 25)} ${++suffix}`;
    names.add(name.toLowerCase());
    // Continue long text on the next row instead of cutting off an answer
    const expanded = rows.flatMap((row) => {
      const cells = row.map((value) => {
        if (typeof value !== 'string') return [value];
        const parts: string[] = [];
        let start = 0;
        while (start < value.length) {
          let end = Math.min(start + 32767, value.length);
          if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1]))
            end -= 1;
          parts.push(value.slice(start, end));
          start = end;
        }
        return parts.length ? parts : [''];
      });
      return Array.from(
        {length: Math.max(1, ...cells.map((cell) => cell.length))},
        (_, index) =>
          cells.map(
            (cell) => cell[index] ?? (cell.length === 1 ? cell[0] : ''),
          ),
      );
    });
    if (expanded.length > 1048576 || rows.some((row) => row.length > 16384))
      throw new Error('Workbook limits');
    const page = book.addWorksheet(name, {
      views: [{state: 'frozen', ySplit: headerRow}],
    });
    // Strings stay text cells, even when a name begins with a formula sign
    page.addRows(expanded);
    const heading = page.getRow(headerRow);
    heading.font = {bold: true, color: {argb: 'FFFFFFFF'}};
    heading.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: {argb: 'FF334155'},
    };
    // Keep empty tables filterable without including metadata rows
    if (filter)
      page.autoFilter = {
        from: {row: headerRow, column: 1},
        to: {
          row: Math.max(headerRow, page.rowCount),
          column: rows[headerRow - 1].length,
        },
      };
    page.columns.forEach((column, index) => {
      column.width = index === 0 ? 48 : 24;
    });
    page.eachRow((row) => {
      row.alignment = {vertical: 'top', wrapText: true};
    });
    return page;
  }
  sheet(t('Сводка'), [
    [t('Комната'), report.roomName],
    [t('Участников'), report.participants],
    [t('Ответов'), report.answers],
    [
      t(
        'Длинный текст продолжается на следующих строках с тем же ID или названием',
      ),
    ],
    [t('Вопрос'), t('Ответы')],
    ...report.questions.map((q) => [markdownSummary(q.content), q.answers]),
    [t('Источник'), t('Ответы')],
    ...report.sources.map((source) => [t(kinds[source.kind]), source.answers]),
    ...(admin
      ? [
          [t('Ссылка'), t('Режим'), t('Участники'), t('Ответы')],
          ...report.links.map((link) => [
            link.name,
            link.mode === 'registration'
              ? t('Ссылки с регистрацией')
              : link.mode === 'personal'
                ? t('Персональная')
                : t('Многоразовая'),
            link.participants,
            link.answers,
          ]),
          [t('Разбивка по ссылкам исключает анонимные вопросы')],
        ]
      : []),
  ]);
  report.sheets.forEach((q, index) => {
    const page = sheet(
      `${index + 1} ${markdownSummary(q.content)}`,
      [
        [t('Вопрос'), q.content],
        [t('Ответы'), q.total],
        [t('Вариант'), t('Голоса'), t('Процент')],
        ...q.options.map((option) => [
          option.content,
          option.count,
          q.total ? Math.round((option.count / q.total) * 10000) / 100 : 0,
        ]),
      ],
      3,
      true,
    );
    page.getColumn(3).numFmt = '0.##"%"';
  });
  if (admin) {
    const questions = report.sheets.filter((q) => !q.anonymous);
    const page = sheet(
      t('По участникам'),
      [
        [
          t('Участник / прохождение'),
          t('Имя участника / ссылки'),
          t('Группа'),
          t('Режим'),
          ...questions.map((q) => markdownSummary(q.content)),
        ],
        ...report.people.map((person) => [
          person.memberId ?? person.id,
          person.name ?? '',
          person.groupName ?? '',
          t(
            kinds[
              person.groupName !== undefined ? 'registration' : person.kind
            ],
          ),
          ...questions.map((q) => {
            const answer = person.answers.find(
              (item) => item.questionId === q.id,
            );
            return answer
              ? answer.choices.length
                ? answer.choices.join('\n')
                : t('Ответ без выбора вариантов')
              : '';
          }),
        ]),
      ],
      1,
      true,
    );
    page.getColumn(1).width = 40;
    page.getColumn(2).width = 32;
    page.getColumn(3).width = 28;
    page.getColumn(4).width = 28;
    questions.forEach((_, index) => {
      page.getColumn(index + 5).width = 40;
    });
  }
  return new Uint8Array(await book.xlsx.writeBuffer());
}
