import {expect, test} from '@playwright/test';
import {votingFixture} from './voting-helpers';

test('opening saves all tabs and an armed question starts with its own close timer', async ({
  page,
  browser,
}, info) => {
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
    .getByLabel('Текст вопроса', {exact: true})
    .fill('Scheduled browser question');
  await page.getByLabel('Вариант 1', {exact: true}).fill('A');
  await page.getByLabel('Вариант 2', {exact: true}).fill('B');
  await page
    .getByRole('tablist', {name: 'Разделы вопроса'})
    .getByRole('tab', {name: 'Управление', exact: true})
    .click();
  await page.getByLabel('Отложенный старт', {exact: true}).check();
  await page.getByLabel('Открыть через', {exact: true}).fill('7');
  await page
    .getByLabel('Единица времени открытия', {exact: true})
    .selectOption('1');
  const deadline = page.getByRole('region', {
    name: 'Срок закрытия',
    exact: true,
  });
  await deadline
    .getByRole('button', {name: 'После открытия', exact: true})
    .click();
  await deadline.getByLabel('Закрыть через', {exact: true}).fill('120');
  await deadline.getByLabel('Единица времени', {exact: true}).selectOption('1');
  const response = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `/api/rooms/${f.room.id}/questions`,
  );
  await page.getByRole('button', {name: 'Открыть вопрос', exact: true}).click();
  const {question} = await (await response).json();
  expect(question.state).toBe('scheduled');
  await expect(
    page.getByRole('button', {name: 'Ожидание открытия', exact: true}),
  ).toBeVisible();
  await expect(
    page.getByRole('button', {name: 'Сохранить изменения', exact: true}),
  ).toHaveCount(0);
  await expect(
    page
      .getByRole('region', {name: 'Время открытия', exact: true})
      .getByRole('timer'),
  ).toBeVisible();
  const device = await browser.newContext();
  try {
    const guest = await device.newPage();
    await guest.goto(f.url);
    await expect(
      guest.getByRole('heading', {
        name: 'Ожидание открытия вопроса',
        exact: true,
      }),
    ).toBeVisible();
    const current = guest.getByRole('region', {
      name: 'Текущий вопрос',
      exact: true,
    });
    await expect(current.getByRole('timer')).toBeVisible();
    await expect(
      current.getByRole('radio', {name: 'A', exact: true}),
    ).toBeVisible({timeout: 12000});
    await expect(
      page.getByRole('button', {name: 'Закрыть вопрос', exact: true}),
    ).toBeVisible();
    await expect(deadline.getByRole('timer')).toBeVisible();
    await guest.screenshot({
      path: info.outputPath('participant-current-question.png'),
      fullPage: true,
      animations: 'disabled',
    });
    await page.screenshot({
      path: info.outputPath('question-start-controls.png'),
      fullPage: true,
      animations: 'disabled',
    });
    await page.getByRole('button', {name: 'Вернуться', exact: true}).click();
    const row = page.getByRole('listitem', {
      name: 'Scheduled browser question',
      exact: true,
    });
    await expect(
      row.getByLabel('Смотрят вопрос: 1', {exact: true}),
    ).toBeVisible({timeout: 10000});
    await current.getByRole('radio', {name: 'A', exact: true}).check();
    await current
      .getByRole('button', {name: 'Отправить ответ', exact: true})
      .click();
    await expect(
      guest.getByRole('heading', {name: 'Все вопросы пройдены', exact: true}),
    ).toBeVisible();
    await expect(
      row.getByLabel('Количество ответов: 1', {exact: true}),
    ).toBeVisible();
    await page.screenshot({
      path: info.outputPath('question-counters.png'),
      fullPage: true,
      animations: 'disabled',
    });
  } finally {
    await device.close();
  }
});

test('skipped questions, answer review and edits use the question tab and return to the list', async ({
  page,
  browser,
}, info) => {
  const f = await votingFixture(page, {
    allowSkip: true,
    allowAnswerChange: true,
    closesAt: null,
  });
  const device = await browser.newContext();
  try {
    const guest = await device.newPage();
    await guest.goto(f.url);
    const tabs = guest.getByRole('tablist', {name: 'Вкладки участника'});
    const current = guest.getByRole('region', {
      name: 'Текущий вопрос',
      exact: true,
    });
    await expect(
      tabs.getByRole('tab', {name: 'Вопрос', exact: true}),
    ).toHaveAttribute('aria-selected', 'true');
    await expect(
      tabs.getByRole('tab', {name: 'Результаты', exact: true}),
    ).toHaveCount(0);
    await current
      .getByRole('button', {name: 'Пропустить вопрос', exact: true})
      .click();
    await guest
      .getByRole('button', {name: 'К списку вопросов', exact: true})
      .click();
    await guest
      .getByRole('button', {name: 'Choose a result', exact: true})
      .click();
    await current.getByRole('radio', {name: 'Yes', exact: true}).check();
    await current
      .getByRole('button', {name: 'Отправить ответ', exact: true})
      .click();
    await expect(
      guest.getByRole('heading', {name: 'Все вопросы пройдены', exact: true}),
    ).toBeVisible();
    await tabs.getByRole('tab', {name: 'Список вопросов', exact: true}).click();
    await guest
      .getByRole('button', {name: 'Choose a result', exact: true})
      .click();
    await expect(
      current.getByRole('radio', {name: 'Yes', exact: true}),
    ).toBeChecked();
    await current.getByRole('button', {name: 'Закрыть', exact: true}).click();
    await expect(
      tabs.getByRole('tab', {name: 'Список вопросов', exact: true}),
    ).toHaveAttribute('aria-selected', 'true');
    await guest
      .getByRole('button', {name: 'Choose a result', exact: true})
      .click();
    await current.getByRole('radio', {name: 'No', exact: true}).check();
    await current
      .getByRole('button', {name: 'Изменить ответ', exact: true})
      .click();
    await expect(
      tabs.getByRole('tab', {name: 'Список вопросов', exact: true}),
    ).toHaveAttribute('aria-selected', 'true');
    await guest.screenshot({
      path: info.outputPath('participant-question-list.png'),
      fullPage: true,
      animations: 'disabled',
    });
  } finally {
    await device.close();
  }
});

test('view counters follow the active question tab and deduplicate personal devices', async ({
  page,
  browser,
}) => {
  const f = await votingFixture(page);
  await page.goto(`/rooms/${f.room.id}`);
  const row = page.getByRole('listitem', {
    name: 'Choose a result',
    exact: true,
  });
  const contexts = await Promise.all([
    browser.newContext(),
    browser.newContext(),
  ]);
  try {
    const guests = await Promise.all(
      contexts.map((context) => context.newPage()),
    );
    for (const guest of guests) await guest.goto(f.url);
    await expect(
      row.getByLabel('Смотрят вопрос: 1', {exact: true}),
    ).toBeVisible({timeout: 10000});
    await guests[0]
      .getByRole('tab', {name: 'Список вопросов', exact: true})
      .click();
    await expect(
      row.getByLabel('Смотрят вопрос: 1', {exact: true}),
    ).toBeVisible();
    await guests[1]
      .getByRole('tab', {name: 'Список вопросов', exact: true})
      .click();
    await expect(
      row.getByLabel('Смотрят вопрос: 0', {exact: true}),
    ).toBeVisible({timeout: 10000});
    await expect(
      page.getByRole('button', {name: 'Обновить', exact: true}),
    ).toHaveCount(0);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
