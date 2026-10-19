import {expect, test} from '@playwright/test';
import {votingFixture} from './voting-helpers';
test('projector uses an independent admin tab and never renders respondent names', async ({
  page,
  browser,
}, info) => {
  const f = await votingFixture(page, {hideResultsUntilEnd: true});
  const document = await page.goto(
    `/rooms/${f.room.id}?projector=1&question=${f.question.id}`,
  );
  expect(document?.headers()['cache-control']).toContain('no-store');
  await expect(
    page.getByText('Результаты пока недоступны', {exact: true}),
  ).toBeVisible();
  await expect(
    page.getByRole('tablist', {name: 'Разделы комнаты'}),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', {name: 'На весь экран', exact: true}),
  ).toBeVisible();
  const device = await browser.newContext();
  try {
    const guest = await device.newPage();
    await guest.goto(f.url);
    await guest.getByRole('radio', {name: 'Yes', exact: true}).check();
    await guest
      .getByRole('button', {name: 'Отправить ответ', exact: true})
      .click();
    await expect(page.getByText('Ответы: 1', {exact: true})).toBeVisible();
    const admin = await page.context().newPage();
    await admin.goto(`/rooms/${f.room.id}`);
    expect(
      (
        await admin.request.post(
          `/api/rooms/${f.room.id}/questions/${f.question.id}/lifecycle`,
          {
            headers: {Origin: f.origin},
            data: {action: 'close', revision: f.question.revision},
          },
        )
      ).status(),
    ).toBe(200);
    await expect(page.getByText('Голосов: 1', {exact: true})).toBeVisible();
    await expect(page.getByText('Alice', {exact: true})).toHaveCount(0);
    await expect(
      page.getByText('Индивидуальные ответы', {exact: true}),
    ).toHaveCount(0);
    const data = await (
      await page.request.get(
        `/api/rooms/${f.room.id}/results?question=${f.question.id}&view=projector`,
      )
    ).json();
    expect(data.result.people).toBeUndefined();
    await page.screenshot({
      path: info.outputPath('projector-results.png'),
      fullPage: true,
      animations: 'disabled',
    });
    await admin.close();
  } finally {
    await device.close();
  }
});
test('respondent page shows the personal current question without exposing votes', async ({
  page,
  browser,
}) => {
  const f = await votingFixture(page);
  await page.goto(`/rooms/${f.room.id}`);
  await page
    .getByRole('tablist', {name: 'Разделы комнаты'})
    .getByRole('tab', {name: 'Респонденты', exact: true})
    .click();
  const context = await browser.newContext();
  try {
    const guest = await context.newPage();
    await guest.goto(f.url);
    const row = page.getByRole('listitem', {name: 'Alice', exact: true});
    await expect(row.getByText('Онлайн', {exact: true})).toBeVisible({
      timeout: 10000,
    });
    await expect(
      row.getByText('Смотрит: Choose a result', {exact: true}),
    ).toBeVisible();
    await guest
      .getByRole('tab', {name: 'Список вопросов', exact: true})
      .click();
    await expect(
      row.getByText('Смотрит: Choose a result', {exact: true}),
    ).toHaveCount(0);
    await expect(row.getByText('Онлайн', {exact: true})).toBeVisible();
    await guest.close();
    await expect(row.getByText('Не в сети', {exact: true})).toBeVisible({
      timeout: 10000,
    });
  } finally {
    await context.close();
  }
});
