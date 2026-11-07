import {expect, test} from '@playwright/test';
import {votingFixture} from './voting-helpers';

// A place vanishes for other people and returns immediately after a release
test('allocation choices update across independent participant sessions', async ({
  page,
  browser,
}) => {
  const f = await votingFixture(page, {
    questionType: 'allocation',
    allowAnswerChange: true,
    choices: [
      {content: 'Slot A', capacity: 1},
      {content: 'Slot B', capacity: 2},
    ],
  });
  const links = await page.request.post(`/api/rooms/${f.room.id}/links`, {
    headers: {Origin: f.origin},
    data: {mode: 'personal', names: ['Bob']},
  });
  const {
    links: [link],
  } = await links.json();
  const {token} = await (
    await page.request.get(`/api/rooms/${f.room.id}/links/${link.id}/secret`)
  ).json();
  const context = await browser.newContext({locale: 'ru-RU'});
  try {
    const other = await context.newPage();
    await page.goto(f.url);
    await other.goto(`${f.origin}/vote/${link.id}#key=${token}`);
    const slot = page.getByRole('checkbox', {name: 'Slot A', exact: true});
    const rival = other.getByRole('checkbox', {name: 'Slot A', exact: true});
    await expect(rival).toBeVisible();
    await slot.click();
    await expect(slot).toBeChecked();
    await expect(rival).toHaveCount(0);
    await page.getByRole('tab', {name: 'Список вопросов', exact: true}).click();
    await expect(
      page.getByRole('region', {name: 'Список вопросов участника'}),
    ).not.toContainText('Slot A');
    await page.getByRole('tab', {name: 'Вопрос', exact: true}).click();
    await slot.click();
    await expect(slot).not.toBeChecked();
    await expect(rival).toBeVisible();
    await rival.click();
    await expect(rival).toBeChecked();
    await expect(slot).toHaveCount(0);
  } finally {
    await context.close();
  }
});

// Each click is saved, but a partial fixed answer cannot finish or be released
test('allocation minimum is required and fixed selections can grow', async ({
  page,
}) => {
  const f = await votingFixture(page, {
    questionType: 'allocation',
    choiceMode: 'multiple',
    minChoices: 2,
    maxChoices: 3,
    choices: [
      {content: 'A', capacity: 1},
      {content: 'B', capacity: 1},
      {content: 'C', capacity: 1},
    ],
  });
  await page.goto(f.url);
  await page.getByRole('checkbox', {name: 'A', exact: true}).click();
  await expect(page.getByText('Выбрано 1 из 3, минимум 2')).toBeVisible();
  await expect(
    page.getByRole('checkbox', {name: 'A', exact: true}),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', {name: 'Продолжить', exact: true}),
  ).toHaveCount(0);
  await expect(
    page.getByRole('status', {name: 'Сохраняем…', exact: true}),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole('checkbox', {name: 'A', exact: true}),
  ).toBeChecked();
  await page.getByRole('checkbox', {name: 'B', exact: true}).click();
  await expect(page.getByText('Выбрано 2 из 3, минимум 2')).toBeVisible();
  await page.getByRole('checkbox', {name: 'C', exact: true}).click();
  await expect(page.getByText('Выбрано 3 из 3, минимум 2')).toBeVisible();
  await page.getByRole('button', {name: 'Продолжить', exact: true}).click();
  await expect(
    page.getByText('Все вопросы пройдены', {exact: true}),
  ).toBeVisible();
});

// The creation menu fixes the kind before opening the editor
test('allocation editor saves its type, per-option capacities and choice limits', async ({
  page,
}) => {
  const f = await votingFixture(page);
  await page.goto(`/rooms/${f.room.id}`);
  await page.getByRole('button', {name: 'Создать вопрос', exact: true}).click();
  await page
    .getByRole('menuitem', {name: 'Бронирование вариантов', exact: true})
    .click();
  await expect(page.getByLabel('Тип вопроса', {exact: true})).toHaveCount(0);
  await page.getByLabel('Текст вопроса', {exact: true}).fill('Book a lab slot');
  await page.getByLabel('Вариант 1', {exact: true}).fill('Morning');
  await page.getByLabel('Вариант 2', {exact: true}).fill('Evening');
  await page
    .getByRole('group', {name: 'Настройки варианта 1', exact: true})
    .getByLabel('Количество доступных мест', {exact: true})
    .fill('3');
  await page
    .getByRole('tablist', {name: 'Разделы вопроса'})
    .getByRole('tab', {name: 'Настройки', exact: true})
    .click();
  await page.getByLabel('Выбор ответа', {exact: true}).selectOption('multiple');
  await page.getByLabel('Минимум вариантов', {exact: true}).fill('2');
  await page.getByLabel('Максимум вариантов', {exact: true}).fill('2');
  await page
    .getByRole('button', {name: 'Сохранить изменения', exact: true})
    .click();
  await expect(
    page.getByText('Изменения сохранены', {exact: true}),
  ).toBeVisible();
  await page
    .getByRole('tablist', {name: 'Разделы вопроса'})
    .getByRole('tab', {name: 'Редактирование', exact: true})
    .click();
  await expect(
    page.getByText('Бронирование вариантов', {exact: true}),
  ).toBeVisible();
  await expect(
    page
      .getByRole('group', {name: 'Настройки варианта 1', exact: true})
      .getByLabel('Количество доступных мест', {exact: true}),
  ).toHaveValue('3');
  await expect(page.locator('time')).not.toHaveCount(0);
});

// Multiple clicks of a manual respondent belong to one ballot
test('allocation manual entry preserves one identity and shares the same place pool', async ({
  page,
}) => {
  const f = await votingFixture(page, {
    questionType: 'allocation',
    allowAnswerChange: true,
    choices: [
      {content: 'Slot A', capacity: 2},
      {content: 'Slot B', capacity: 1},
    ],
  });
  await page.goto(`/rooms/${f.room.id}`);
  await page.getByRole('button', {name: 'Просмотреть', exact: true}).click();
  await page
    .getByRole('tablist', {name: 'Разделы вопроса'})
    .getByRole('tab', {name: 'Управление', exact: true})
    .click();
  await page
    .getByRole('button', {name: 'Ввести голос вручную', exact: true})
    .click();
  const manual = page.getByRole('region', {
    name: 'Ручное голосование',
    exact: true,
  });
  await manual.getByRole('checkbox', {name: 'Slot A', exact: true}).click();
  await expect(
    manual.getByRole('checkbox', {name: 'Slot A', exact: true}),
  ).toBeChecked();
  await manual.getByRole('checkbox', {name: 'Slot B', exact: true}).click();
  await expect(
    manual.getByRole('checkbox', {name: 'Slot B', exact: true}),
  ).toBeChecked();
  await manual.getByRole('button', {name: 'Продолжить', exact: true}).click();
  await expect(manual.getByText('Голос сохранен', {exact: true})).toBeVisible();
  const result = await page.request.get(
    `/api/rooms/${f.room.id}/results?question=${f.question.id}`,
  );
  expect(result.ok()).toBe(true);
  const body = await result.json();
  expect(body.result.total).toBe(1);
  expect(body.result.options.map((o: {count: number}) => o.count)).toEqual([
    0, 1,
  ]);
  await page.goto(f.url);
  await expect(
    page.getByRole('checkbox', {name: 'Slot A', exact: true}),
  ).toBeVisible();
  await expect(
    page.getByRole('checkbox', {name: 'Slot B', exact: true}),
  ).toHaveCount(0);
});

// Losing a successful reply must retry the same claim instead of booking twice
test('allocation retries an uncertain save with the same request identity', async ({
  page,
}) => {
  const f = await votingFixture(page, {
    questionType: 'allocation',
    allowAnswerChange: true,
    choices: [
      {content: 'Slot A', capacity: 2},
      {content: 'Slot B', capacity: 1},
    ],
  });
  await page.goto(f.url);
  let first = true;
  const bodies: unknown[] = [];
  await page.route(
    `**/api/vote/${f.link.id}/answers/${f.question.id}`,
    async (route) => {
      bodies.push(route.request().postDataJSON());
      if (first) {
        first = false;
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        await route.abort('failed');
      } else await route.continue();
    },
  );
  await page.getByRole('checkbox', {name: 'Slot A', exact: true}).click();
  await expect(
    page.getByRole('alert').filter({hasText: 'Не удалось подтвердить выбор'}),
  ).toBeVisible();
  await page
    .getByRole('button', {name: 'Повторить попытку', exact: true})
    .click();
  await expect(
    page.getByRole('checkbox', {name: 'Slot A', exact: true}),
  ).toBeChecked();
  await expect(
    page.getByRole('button', {name: 'Повторить попытку', exact: true}),
  ).toHaveCount(0);
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toEqual(bodies[0]);
  const result = await page.request.get(
    `/api/rooms/${f.room.id}/results?question=${f.question.id}`,
  );
  const body = await result.json();
  expect(body.result.total).toBe(1);
  expect(body.result.options[0].count).toBe(1);
});
