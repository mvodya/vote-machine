import {expect, test, type Page} from '@playwright/test';

// Start with a real room and a valid admin cookie
async function setup(page: Page) {
  await page.goto('/');
  await page
    .getByLabel('Название комнаты', {exact: true})
    .fill('Questions browser');
  await page
    .getByRole('button', {name: 'Создать комнату', exact: true})
    .click();
  await expect(
    page.getByRole('heading', {name: 'Questions browser', exact: true}),
  ).toBeVisible();
  await expect(page.getByText('Вопросов пока нет')).toBeVisible();
  return new URL(page.url()).pathname.split('/').at(-1)!;
}
// Keep the API fixture equal to an empty editor draft
function draft(content = '') {
  return {
    content,
    choiceMode: 'single',
    minChoices: 1,
    maxChoices: 1,
    shareResults: false,
    publication: 'after_close',
    hideResultsUntilEnd: false,
    allowAnswerChange: false,
    anonymous: false,
    choices: [],
  };
}
// Add fixture drafts through the same real API used by the form
async function create(page: Page, room: string, content: string) {
  const response = await page.request.post(`/api/rooms/${room}/questions`, {
    headers: {Origin: new URL(page.url()).origin},
    data: draft(content),
  });
  expect(response.status()).toBe(201);
  return (await response.json()).question;
}

test('empty draft, editor settings, stable option order, reload and confirmed deletion', async ({
  page,
}, info) => {
  await setup(page);
  await page.getByRole('button', {name: 'Создать вопрос', exact: true}).click();
  await page
    .getByRole('button', {name: 'Сохранить черновик', exact: true})
    .click();
  await expect(page.getByText('Вопрос сохранен', {exact: true})).toBeVisible();
  await page
    .getByLabel('Текст вопроса', {exact: true})
    .fill('Утвердить решение?');
  await page.getByLabel('Вариант 1', {exact: true}).fill('За');
  await page.getByLabel('Вариант 2', {exact: true}).fill('Против');
  await page
    .getByRole('button', {name: 'Добавить вариант', exact: true})
    .click();
  await page.getByLabel('Вариант 3', {exact: true}).fill('Воздержался');
  await page
    .getByRole('button', {name: 'Поднять вариант 3', exact: true})
    .click();
  await expect(page.getByLabel('Вариант 2', {exact: true})).toHaveValue(
    'Воздержался',
  );
  await page.getByLabel('Выбор ответа', {exact: true}).selectOption('multiple');
  await page.getByLabel('Минимум вариантов', {exact: true}).fill('2');
  await page.getByLabel('Максимум вариантов', {exact: true}).fill('3');
  await page
    .getByLabel('Публиковать результаты участникам', {exact: true})
    .check();
  await page
    .getByLabel('Когда публиковать результаты', {exact: true})
    .selectOption('after_answer');
  await page
    .getByLabel(
      'Скрывать результаты до окончания голосования, включая администратора',
      {exact: true},
    )
    .check();
  await page.getByLabel('Разрешить изменение ответа', {exact: true}).check();
  await page.getByLabel('Анонимные ответы', {exact: true}).check();
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === 'PATCH' &&
      /\/questions\/[0-9a-f-]+$/.test(new URL(response.url()).pathname),
  );
  await page
    .getByRole('button', {name: 'Сохранить черновик', exact: true})
    .click();
  expect((await saved).status()).toBe(200);
  await page.getByRole('button', {name: 'К списку', exact: true}).click();
  const row = page.getByRole('listitem', {
    name: 'Утвердить решение?',
    exact: true,
  });
  await expect(row).toBeVisible();
  await expect(row).toContainText('Черновик');
  await expect(row).toContainText('Вариантов: 3');
  await page.reload();
  await row.getByRole('button', {name: 'Редактировать', exact: true}).click();
  await expect(page.getByLabel('Вариант 2', {exact: true})).toHaveValue(
    'Воздержался',
  );
  await expect(page.getByLabel('Выбор ответа', {exact: true})).toHaveValue(
    'multiple',
  );
  await expect(page.getByLabel('Минимум вариантов', {exact: true})).toHaveValue(
    '2',
  );
  await expect(
    page.getByLabel('Анонимные ответы', {exact: true}),
  ).toBeChecked();
  await expect(
    page.getByText('Администратор не может редактировать этот вопрос', {
      exact: true,
    }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath('question-editor.png'),
    fullPage: true,
  });
  await page.getByRole('button', {name: 'К списку', exact: true}).click();
  await row
    .getByRole('button', {
      name: 'Удалить вопрос: Утвердить решение?',
      exact: true,
    })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', {name: 'Отмена', exact: true})
    .click();
  await expect(row).toBeVisible();
  await row
    .getByRole('button', {
      name: 'Удалить вопрос: Утвердить решение?',
      exact: true,
    })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', {name: 'Удалить', exact: true})
    .click();
  await expect(page.getByText('Вопросов пока нет')).toBeVisible();
});

test('two editors reject old revisions and keep unsaved text until explicit reload', async ({
  page,
  context,
}) => {
  const room = await setup(page);
  const q = await create(page, room, 'Shared draft');
  await page.getByRole('button', {name: 'Обновить', exact: true}).click();
  await page
    .getByRole('listitem', {name: 'Shared draft', exact: true})
    .getByRole('button', {name: 'Редактировать', exact: true})
    .click();
  const second = await context.newPage();
  try {
    await second.goto(page.url());
    await second
      .getByRole('listitem', {name: 'Shared draft', exact: true})
      .getByRole('button', {name: 'Редактировать', exact: true})
      .click();
    await page.getByLabel('Текст вопроса', {exact: true}).fill('First edit');
    await page
      .getByRole('button', {name: 'Сохранить черновик', exact: true})
      .click();
    await expect(
      page.getByText('Вопрос сохранен', {exact: true}),
    ).toBeVisible();
    await second
      .getByLabel('Текст вопроса', {exact: true})
      .fill('Second unsaved edit');
    await second
      .getByRole('button', {name: 'Сохранить черновик', exact: true})
      .click();
    await expect(
      second
        .getByRole('alert')
        .filter({hasText: 'Вопрос изменен в другой вкладке'}),
    ).toBeVisible();
    await expect(second.getByLabel('Текст вопроса', {exact: true})).toHaveValue(
      'Second unsaved edit',
    );
    expect(
      (
        await (
          await page.request.get(`/api/rooms/${room}/questions/${q.id}`)
        ).json()
      ).question.content,
    ).toBe('First edit');
    await second
      .getByRole('button', {name: 'Загрузить актуальную версию', exact: true})
      .click();
    await expect(second.getByLabel('Текст вопроса', {exact: true})).toHaveValue(
      'First edit',
    );
  } finally {
    await second.close();
  }
});

test('room edit rule persists and stale rule changes are rejected', async ({
  page,
}) => {
  const room = await setup(page);
  await page.getByRole('tab', {name: 'Настройки', exact: true}).click();
  const panel = page.getByRole('region', {name: 'Редактирование вопросов'});
  // Panel is a section with its own accessible name
  const rule = page.getByLabel('Запретить редактирование после открытия', {
    exact: true,
  });
  await expect(rule).toBeEnabled();
  await expect(rule).toBeChecked();
  const old = (
    await (await page.request.get(`/api/rooms/${room}/question-policy`)).json()
  ).policy;
  await rule.uncheck();
  await expect(
    page.getByText('Правило сохранено', {exact: true}),
  ).toBeVisible();
  const conflict = await page.request.patch(
    `/api/rooms/${room}/question-policy`,
    {
      headers: {Origin: new URL(page.url()).origin},
      data: {...old, lockAfterOpen: true},
    },
  );
  expect(conflict.status()).toBe(409);
  await page.reload();
  await page.getByRole('tab', {name: 'Настройки', exact: true}).click();
  await expect(rule).toBeEnabled();
  await expect(rule).not.toBeChecked();
  await expect(panel).toBeVisible();
});

test('metadata pages survive a deleted boundary and a failed list request', async ({
  page,
}) => {
  const room = await setup(page);
  const drafts = [];
  for (let index = 0; index < 52; index++)
    drafts.push(await create(page, room, `Draft ${index}`));
  await page.getByRole('button', {name: 'Обновить', exact: true}).click();
  await expect(page.getByRole('listitem')).toHaveCount(50);
  const boundary = drafts[49];
  const deleted = await page.request.delete(
    `/api/rooms/${room}/questions/${boundary.id}`,
    {
      headers: {Origin: new URL(page.url()).origin},
      data: {revision: boundary.revision},
    },
  );
  expect(deleted.status()).toBe(200);
  await page.getByRole('button', {name: 'Далее', exact: true}).click();
  await expect(page.getByRole('listitem')).toHaveCount(2);
  await page.getByRole('button', {name: 'Назад', exact: true}).click();
  await expect(page.getByRole('listitem')).toHaveCount(50);
  await page.route(
    `**/api/rooms/${room}/questions?after=*`,
    (route) => route.fulfill({status: 503, json: {error: 'Unavailable'}}),
    {times: 1},
  );
  await page.getByRole('button', {name: 'Обновить', exact: true}).click();
  await expect(
    page.getByText('Не удалось загрузить вопросы', {exact: true}),
  ).toBeVisible();
  await page
    .getByRole('button', {name: 'Попробовать снова', exact: true})
    .click();
  await expect(page.getByRole('listitem')).toHaveCount(50);
});

test('room settings save on blur and toggle without separate action buttons', async ({
  page,
}, info) => {
  const room = await setup(page);
  await page.getByRole('tab', {name: 'Настройки', exact: true}).click();
  const rule = page.getByLabel('Запретить редактирование после открытия', {
    exact: true,
  });
  await expect(rule).toBeEnabled();
  await expect(
    page.getByRole('button', {
      name: 'Загрузить актуальное правило',
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', {name: 'Сохранить правило', exact: true}),
  ).toHaveCount(0);
  const input = page.getByLabel('Название комнаты', {exact: true});
  await expect(
    page.getByRole('button', {name: 'Сохранить название', exact: true}),
  ).toHaveCount(0);
  await input.fill('Automatic room');
  const check = page.getByRole('button', {
    name: 'Сохранить название',
    exact: true,
  });
  const bounds = await input.boundingBox();
  const action = await check.boundingBox();
  expect(action!.x).toBeGreaterThan(bounds!.x);
  expect(action!.x + action!.width).toBeLessThanOrEqual(
    bounds!.x + bounds!.width,
  );
  await input.press('Tab');
  await expect(
    page.getByRole('heading', {name: 'Automatic room', exact: true}),
  ).toBeVisible();
  await expect(check).toHaveCount(0);
  // The name save changed the room version used by the rule
  await rule.uncheck();
  await expect(
    page.getByText('Правило сохранено', {exact: true}),
  ).toBeVisible();
  const saved = await page.request.get(`/api/rooms/${room}/question-policy`);
  expect((await saved.json()).policy.lockAfterOpen).toBe(false);
  await input.fill('Inline save');
  await check.click();
  await expect(
    page.getByRole('heading', {name: 'Inline save', exact: true}),
  ).toBeVisible();
  await expect(check).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath('automatic-settings.png'),
    fullPage: true,
  });
});
