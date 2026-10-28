import ExcelJS from 'exceljs';
import type {RoomReport} from '../room-report';
import {markdownSummary} from '../markdown';

const kinds: Record<string, string> = {
  personal: 'Персональная ссылка',
  reusable: 'Многоразовая ссылка',
  admin_manual: 'Ручной ввод',
};

// Build a workbook only from an already filtered server snapshot
export async function resultsWorkbook(report: RoomReport, admin: boolean) {
  const book = new ExcelJS.Workbook();
  book.creator = 'Vote Machine';
  book.created = new Date();
  const names = new Set<string>();
  // Excel names must be short, unique and free of special characters
  function sheet(title: string, rows: (string | number)[][]) {
    const base =
      title
        .replace(/[\\/*?:\[\]\x00-\x1f]/g, ' ')
        .replace(/^'+|'+$/g, '')
        .trim()
        .slice(0, 28) || 'Вопрос';
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
      views: [{state: 'frozen', ySplit: 1}],
    });
    // Strings stay text cells, even when a name begins with a formula sign
    page.addRows(expanded);
    page.getRow(1).font = {bold: true};
    page.columns.forEach((column, index) => {
      column.width = index === 0 ? 48 : 24;
    });
    page.eachRow((row) => {
      row.alignment = {vertical: 'top', wrapText: true};
    });
    return page;
  }
  sheet('Сводка', [
    ['Комната', report.roomName],
    ['Участников', report.participants],
    ['Ответов', report.answers],
    [
      'Длинный текст продолжается на следующих строках с тем же ID или названием',
    ],
    ['Вопрос', 'Ответы'],
    ...report.questions.map((q) => [markdownSummary(q.content), q.answers]),
    ['Источник', 'Ответы'],
    ...report.sources.map((source) => [kinds[source.kind], source.answers]),
    ...(admin
      ? [
          ['Ссылка', 'Режим', 'Участники', 'Ответы'],
          ...report.links.map((link) => [
            link.name,
            link.mode === 'personal' ? 'Персональная' : 'Многоразовая',
            link.participants,
            link.answers,
          ]),
          ['Разбивка по ссылкам исключает анонимные вопросы'],
        ]
      : []),
  ]);
  report.sheets.forEach((q, index) => {
    sheet(`${index + 1} ${markdownSummary(q.content)}`, [
      ['Вопрос', q.content],
      ['Ответы', q.total],
      ['Вариант', 'Голоса', 'Процент'],
      ...q.options.map((option) => [
        option.content,
        option.count,
        q.total ? Math.round((option.count / q.total) * 10000) / 100 : 0,
      ]),
    ]);
  });
  if (admin) {
    const questions = report.sheets.filter((q) => !q.anonymous);
    sheet('По участникам', [
      [
        'Участник / прохождение',
        'Имя ссылки',
        'Режим',
        ...questions.map((q) => markdownSummary(q.content)),
      ],
      ...report.people.map((person) => [
        person.id,
        person.name ?? '',
        kinds[person.kind],
        ...questions.map((q) => {
          const answer = person.answers.find(
            (item) => item.questionId === q.id,
          );
          return answer
            ? answer.choices.length
              ? answer.choices.join('\n')
              : 'Ответ без выбора вариантов'
            : '';
        }),
      ]),
    ]);
  }
  return new Uint8Array(await book.xlsx.writeBuffer());
}
