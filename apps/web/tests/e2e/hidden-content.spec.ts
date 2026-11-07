import {expect, test} from '@playwright/test';
import {votingFixture} from './voting-helpers';

test('scheduled content stays hidden and appears live when the question opens', async ({
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
  await page.getByRole('button', {name: 'Создать вопрос', exact: true}).click();
  await page
    .getByRole('menuitem', {name: 'Выбор варианта', exact: true})
    .click();
  await page
    .getByLabel('Текст вопроса', {exact: true})
    .fill('Private scheduled question');
  await page.getByLabel('Вариант 1', {exact: true}).fill('Private option A');
  await page.getByLabel('Вариант 2', {exact: true}).fill('Private option B');
  await page.getByRole('tab', {name: 'Настройки', exact: true}).last().click();
  const hide = page.getByLabel('Скрывать содержимое вопроса до открытия', {
    exact: true,
  });
  await expect(hide).toBeChecked();
  await page.getByRole('tab', {name: 'Управление', exact: true}).click();
  await page.getByLabel('Отложенный старт', {exact: true}).check();
  await page.getByLabel('Открыть через', {exact: true}).fill('15');
  await page
    .getByLabel('Единица времени открытия', {exact: true})
    .selectOption('1');
  await page.getByRole('button', {name: 'Открыть вопрос', exact: true}).click();
  await expect(
    page.getByRole('button', {name: 'Ожидание открытия', exact: true}),
  ).toBeVisible();
  const device = await browser.newContext({locale: 'ru-RU'});
  try {
    const guest = await device.newPage();
    await guest.goto(f.url);
    const current = guest.getByRole('region', {
      name: 'Текущий вопрос',
      exact: true,
    });
    await expect(
      guest.getByRole('heading', {
        name: 'Ожидание открытия вопроса',
        exact: true,
      }),
    ).toBeVisible();
    await expect(current.getByRole('timer')).toBeVisible();
    await expect(
      guest.getByText('Private scheduled question', {exact: true}),
    ).toHaveCount(0);
    await expect(
      guest.getByText('Private option A', {exact: true}),
    ).toHaveCount(0);
    await expect(
      current.getByRole('radio', {name: 'Private option A', exact: true}),
    ).toBeVisible({timeout: 25000});
    await expect(
      current.getByText('Private scheduled question', {exact: true}),
    ).toBeVisible();
  } finally {
    await device.close();
  }
});
