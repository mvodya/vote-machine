import {expect, test} from '@playwright/test';
import {votingFixture} from './voting-helpers';

test('a shared room zone overrides participant device time and editor changes keep the same instant', async ({
  page,
  browser,
}) => {
  const f = await votingFixture(page);
  await page.goto(`/rooms/${f.room.id}`);
  const roomTabs = page.getByRole('tablist', {name: 'Разделы комнаты'});
  await roomTabs.getByRole('tab', {name: 'Настройки', exact: true}).click();
  const local = await page.evaluate(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  await expect(
    page.getByLabel('Часовой пояс комнаты', {exact: true}),
  ).toHaveValue(local);
  if (local === 'Asia/Vladivostok') {
    await page
      .getByLabel('Часовой пояс комнаты', {exact: true})
      .selectOption('UTC');
    await expect(
      page.getByLabel('Часовой пояс комнаты', {exact: true}),
    ).toHaveValue('UTC');
  }
  await page
    .getByLabel('Часовой пояс комнаты', {exact: true})
    .selectOption('Asia/Vladivostok');
  await expect(
    page.getByLabel('Часовой пояс комнаты', {exact: true}),
  ).toHaveValue('Asia/Vladivostok');
  await expect(
    page.getByText('Часовой пояс сохранен', {exact: true}),
  ).toBeVisible();
  const response = await page.request.get(
    `/api/rooms/${f.room.id}/questions/${f.question.id}`,
  );
  const {question} = await response.json();
  expect(
    (
      await page.request.post(
        `/api/rooms/${f.room.id}/questions/${question.id}/lifecycle`,
        {
          headers: {Origin: f.origin},
          data: {
            action: 'settings',
            revision: question.revision,
            closesAt: '2027-01-01T00:00:30.123Z',
            shareResults: false,
            publication: 'after_close',
          },
        },
      )
    ).status(),
  ).toBe(200);
  await roomTabs.getByRole('tab', {name: 'Вопросы', exact: true}).click();
  await page
    .getByRole('listitem', {name: 'Choose a result', exact: true})
    .getByRole('button', {name: 'Просмотреть', exact: true})
    .click();
  const tabs = page.getByRole('tablist', {name: 'Разделы вопроса'});
  await tabs.getByRole('tab', {name: 'Управление', exact: true}).click();
  await expect(page.getByLabel('Время закрытия', {exact: true})).toHaveValue(
    '10:00:30',
  );
  await tabs.getByRole('tab', {name: 'Настройки', exact: true}).click();
  await page
    .getByLabel('Публиковать результаты участникам', {exact: true})
    .check();
  await page
    .getByRole('button', {name: 'Сохранить изменения', exact: true})
    .click();
  await expect(
    page.getByRole('button', {name: 'Вернуться', exact: true}),
  ).toBeVisible();
  const latest = (
    await (
      await page.request.get(`/api/rooms/${f.room.id}/questions/${question.id}`)
    ).json()
  ).question;
  expect(new Date(latest.closesAt).toISOString()).toBe(
    '2027-01-01T00:00:30.123Z',
  );
  const device = await browser.newContext({timezoneId: 'America/Los_Angeles'});
  const participant = await device.newPage();
  try {
    await participant.goto(f.url);
    const current = participant.getByRole('region', {
      name: 'Текущий вопрос',
      exact: true,
    });
    await expect(current.getByText(/01\.01\.2027.*10:00:30/)).toBeVisible();
    await expect(
      current.getByText(
        'Администратор сможет увидеть, с какой ссылки получен ответ',
      ),
    ).toHaveCount(0);
    const radio = await current
      .getByRole('radio', {name: 'Yes', exact: true})
      .boundingBox();
    const text = await current.getByText('Yes', {exact: true}).boundingBox();
    expect(
      Math.abs(radio!.y + radio!.height / 2 - (text!.y + text!.height / 2)),
    ).toBeLessThanOrEqual(2);
  } finally {
    await device.close();
  }
});

test('Markdown help is hidden until requested and closes with Escape', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('Название комнаты', {exact: true}).fill('Help browser');
  await page
    .getByRole('button', {name: 'Создать комнату', exact: true})
    .click();
  await page.getByRole('button', {name: 'Создать вопрос', exact: true}).click();
  await page
    .getByRole('menuitem', {name: 'Выбор варианта', exact: true})
    .click();
  await expect(page.getByText('До 20 000 символов', {exact: true})).toHaveCount(
    0,
  );
  const button = page.getByRole('button', {
    name: 'Справка: Текст вопроса',
    exact: true,
  });
  await button.click();
  await expect(page.getByRole('tooltip')).toContainText('До 20 000 символов');
  await expect(page.getByRole('tooltip')).toContainText('width=320');
  const tooltip = await page.getByRole('tooltip').boundingBox();
  expect(tooltip!.x).toBeGreaterThanOrEqual(0);
  expect(tooltip!.x + tooltip!.width).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
  const help = await button.boundingBox();
  const bold = await page
    .getByRole('button', {name: 'Жирный текст: Текст вопроса', exact: true})
    .boundingBox();
  expect(
    Math.abs(help!.y + help!.height / 2 - bold!.y - bold!.height / 2),
  ).toBeLessThanOrEqual(2);

  await button.press('Escape');
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await expect(
    page.getByRole('button', {name: 'Сохранить изменения', exact: true}),
  ).toHaveCount(0);
});

test('deleting an open question with a personal answer removes it from both views', async ({
  page,
  browser,
}) => {
  const f = await votingFixture(page);
  const device = await browser.newContext();
  const participant = await device.newPage();
  try {
    await participant.goto(f.url);
    const current = participant.getByRole('region', {
      name: 'Текущий вопрос',
      exact: true,
    });
    await current.getByRole('radio', {name: 'Yes', exact: true}).check();
    await current
      .getByRole('button', {name: 'Отправить ответ', exact: true})
      .click();
    await expect(
      participant.getByRole('heading', {name: 'Все вопросы пройдены'}),
    ).toBeVisible();
    await participant
      .getByRole('tab', {name: 'Список вопросов', exact: true})
      .click();
    await expect(
      participant.getByRole('button', {name: 'Choose a result', exact: true}),
    ).toBeVisible();
    await page.goto(`/rooms/${f.room.id}`);
    await page
      .getByRole('listitem', {name: 'Choose a result', exact: true})
      .getByRole('button', {
        name: 'Удалить вопрос: Choose a result',
        exact: true,
      })
      .click();
    await page
      .getByRole('dialog')
      .getByRole('button', {name: 'Удалить', exact: true})
      .click();
    await expect(page.getByText('Вопросов пока нет')).toBeVisible();
    await expect(
      participant.getByRole('button', {name: 'Choose a result', exact: true}),
    ).toHaveCount(0, {timeout: 10000});
    expect(
      (
        await participant.request.get(
          `${f.origin}/api/vote/${f.link.id}/answers/${f.question.id}`,
        )
      ).status(),
    ).toBe(404);
  } finally {
    await device.close();
  }
});
