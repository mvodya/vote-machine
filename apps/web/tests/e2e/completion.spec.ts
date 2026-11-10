import {expect, test} from '@playwright/test';
import {votingFixture} from './voting-helpers';

test('a configured personal electorate closes the question on its last answer', async ({
  page,
  browser,
}) => {
  const f = await votingFixture(page);
  await page.request.post(
    `/api/rooms/${f.room.id}/questions/${f.question.id}/lifecycle`,
    {
      headers: {Origin: f.origin},
      data: {action: 'close', revision: f.question.revision},
    },
  );
  await page.goto(`/rooms/${f.room.id}`);
  await page
    .getByRole('listitem', {name: 'Choose a result', exact: true})
    .getByRole('button', {name: 'Редактировать', exact: true})
    .click();
  const tabs = page.getByRole('tablist', {name: 'Разделы вопроса'});
  await tabs.getByRole('tab', {name: 'Настройки', exact: true}).click();
  await page
    .getByLabel(
      'Скрывать результаты до окончания голосования, включая администратора',
      {exact: true},
    )
    .check();
  await tabs.getByRole('tab', {name: 'Управление', exact: true}).click();
  await page
    .getByLabel('Закрыть, когда ответят все выбранные участники', {exact: true})
    .check();
  await page
    .getByRole('button', {name: 'Выбрать действующие ссылки', exact: true})
    .click();
  await expect(page.getByLabel('Alice', {exact: true})).toBeChecked();
  await page.getByRole('button', {name: 'Открыть вопрос', exact: true}).click();
  await expect(page.getByRole('dialog')).toContainText(
    'Результаты снова будут скрыты',
  );
  await page
    .getByRole('dialog')
    .getByRole('button', {name: 'Открыть вопрос', exact: true})
    .click();
  await expect(
    page.getByRole('button', {name: 'Закрыть вопрос', exact: true}),
  ).toBeVisible();
  await expect(
    page.getByLabel('Закрыть, когда ответят все выбранные участники', {
      exact: true,
    }),
  ).toBeDisabled();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const before = await (
    await page.request.get(
      `/api/rooms/${f.room.id}/results?question=${f.question.id}`,
    )
  ).json();
  expect(before.result.available).toBe(false);
  const device = await browser.newContext();
  try {
    const guest = await device.newPage();
    await guest.goto(f.url);
    await guest.getByRole('radio', {name: 'Yes', exact: true}).check();
    await guest
      .getByRole('button', {name: 'Отправить ответ', exact: true})
      .click();
    await expect(
      guest.getByRole('heading', {name: 'Все вопросы пройдены', exact: true}),
    ).toBeVisible();
    await expect(
      page.getByRole('button', {name: 'Открыть вопрос', exact: true}),
    ).toBeVisible();
    const {question} = await (
      await page.request.get(
        `/api/rooms/${f.room.id}/questions/${f.question.id}`,
      )
    ).json();
    expect(question.closedReason).toBe('all_voted');
    const snapshot = await (
      await guest.request.get(
        `/api/vote/${f.link.id}/questions?selected=${f.question.id}`,
      )
    ).text();
    expect(snapshot).not.toContain('expectedLinkIds');
    expect(
      (
        await (
          await page.request.get(
            `/api/rooms/${f.room.id}/results?question=${f.question.id}`,
          )
        ).json()
      ).result.total,
    ).toBe(1);
  } finally {
    await device.close();
  }
});
