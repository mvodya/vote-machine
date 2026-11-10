import {expect, test} from '@playwright/test';
import ExcelJS from 'exceljs';
import {votingFixture} from './voting-helpers';

// Read the actual download instead of trusting its extension
async function workbook(bytes: Uint8Array) {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(new Uint8Array(bytes).buffer);
  return book;
}

test('room summary sharing is live, independent of question sharing and XLSX stays role filtered', async ({
  page,
  browser,
}, info) => {
  const f = await votingFixture(page);
  const device = await browser.newContext({viewport: page.viewportSize()!});
  try {
    const participant = await device.newPage();
    await participant.goto(f.url);
    await participant.getByRole('radio', {name: 'Yes', exact: true}).check();
    await participant
      .getByRole('button', {name: 'Отправить ответ', exact: true})
      .click();
    await expect(
      participant.getByRole('heading', {name: 'Все вопросы пройдены'}),
    ).toBeVisible();
    expect(
      (
        await participant.request.get(
          `/api/vote/${f.link.id}/results?view=summary`,
        )
      ).status(),
    ).toBe(403);
    await page.goto(`/rooms/${f.room.id}`);
    await page.getByRole('tab', {name: 'Результаты', exact: true}).click();
    const summary = page.getByRole('region', {
      name: 'Общие результаты',
      exact: true,
    });
    await expect(
      summary.getByText('Проголосовало', {exact: true}),
    ).toBeVisible();
    await expect(
      summary.getByText('Alice (участников: 1)', {exact: true}),
    ).toHaveCount(0);
    const adminFile = await page.request.get(
      `/api/rooms/${f.room.id}/results?format=xlsx`,
    );
    expect(adminFile.status()).toBe(200);
    expect(adminFile.headers()['cache-control']).toContain('no-store');
    const adminBook = await workbook(await adminFile.body());
    expect(adminBook.worksheets).toHaveLength(3);
    expect(adminBook.getWorksheet('По участникам')!.getCell('B2').value).toBe(
      'Alice',
    );
    await page.getByRole('tab', {name: 'Настройки', exact: true}).click();
    const sharing = page.getByRole('checkbox', {
      name: 'Показывать все результаты',
      exact: true,
    });
    await expect(sharing).not.toBeChecked();
    await sharing.check();
    await expect(sharing).toBeEnabled();
    await expect(
      participant.getByRole('tab', {name: 'Результаты', exact: true}),
    ).toBeVisible();
    await participant
      .getByRole('tab', {name: 'Результаты', exact: true})
      .click();
    const publicSummary = participant.getByRole('region', {
      name: 'Общие результаты',
      exact: true,
    });
    await expect(
      publicSummary.getByText('Проголосовало', {exact: true}),
    ).toBeVisible();
    await expect(publicSummary.getByText('Alice', {exact: true})).toHaveCount(
      0,
    );
    await expect(
      publicSummary.getByRole('heading', {
        name: 'Ответы по ссылкам',
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      participant.getByRole('button', {
        name: 'Результаты: Choose a result',
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      participant.getByRole('heading', {
        name: 'Результатов пока нет',
        exact: true,
      }),
    ).toHaveCount(0);
    const download = participant.waitForEvent('download');
    await publicSummary
      .getByRole('button', {name: 'Скачать XLSX', exact: true})
      .click();
    const file = await download;
    expect(file.suggestedFilename()).toBe('results.xlsx');
    const publicFile = await participant.request.get(
      `/api/vote/${f.link.id}/results?format=xlsx`,
    );
    const publicBook = await workbook(await publicFile.body());
    expect(publicBook.worksheets.map((sheet) => sheet.name)).toEqual([
      'Сводка',
    ]);
    await participant.screenshot({
      path: info.outputPath('room-summary.png'),
      fullPage: true,
    });
    await sharing.uncheck();
    await expect(sharing).toBeEnabled();
    await expect(
      participant.getByRole('tab', {name: 'Результаты', exact: true}),
    ).toHaveCount(0);
    expect(
      (
        await participant.request.get(
          `/api/vote/${f.link.id}/results?format=xlsx`,
        )
      ).status(),
    ).toBe(403);
  } finally {
    await device.close();
  }
});

test('anonymous XLSX contains aggregates but no participant associations', async ({
  page,
  browser,
}) => {
  const f = await votingFixture(page, {
    anonymous: true,
    shareResults: true,
    publication: 'after_answer',
  });
  const enabled = await page.request.patch(
    `/api/rooms/${f.room.id}/experience`,
    {headers: {Origin: f.origin}, data: {showAllResults: true}},
  );
  expect(enabled.status()).toBe(200);
  const device = await browser.newContext({viewport: page.viewportSize()!});
  try {
    const participant = await device.newPage();
    await participant.goto(f.url);
    await participant.getByRole('radio', {name: 'Yes', exact: true}).check();
    await participant
      .getByRole('button', {name: 'Отправить ответ', exact: true})
      .click();
    await expect(
      participant.getByRole('heading', {name: 'Все вопросы пройдены'}),
    ).toBeVisible();
    const adminResponse = await page.request.get(
      `/api/rooms/${f.room.id}/results?format=xlsx`,
    );
    expect(adminResponse.status()).toBe(200);
    const adminBook = await workbook(await adminResponse.body());
    expect(adminBook.getWorksheet('По участникам')!.rowCount).toBe(1);
    expect(adminBook.getWorksheet('По участникам')!.columnCount).toBe(3);
    const publicResponse = await participant.request.get(
      `/api/vote/${f.link.id}/results?format=xlsx`,
    );
    expect(publicResponse.status()).toBe(200);
    const publicBook = await workbook(await publicResponse.body());
    expect(publicBook.worksheets).toHaveLength(2);
    expect(publicBook.worksheets[1].getCell('B4').value).toBe(1);
    const rows: unknown[] = [];
    publicBook.worksheets.forEach((sheet) =>
      sheet.eachRow((row) => rows.push(row.values)),
    );
    expect(JSON.stringify(rows)).not.toContain('Alice');
    expect(JSON.stringify(rows)).not.toContain(f.link.id);
    expect(publicBook.getWorksheet('По участникам')).toBeUndefined();
  } finally {
    await device.close();
  }
});
