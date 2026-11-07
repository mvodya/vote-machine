import {expect, test} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {votingFixture} from './voting-helpers';

test('logo, connection details and app information fit a narrow screen', async ({
  page,
}, info) => {
  await page.setViewportSize({width: 320, height: 740});
  await page.goto('/');
  await expect(
    page.locator('[data-hero-brand] img[src="/brand/votemachine-icon.svg"]'),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole('button', {name: 'Подключение', exact: true}).click();
  const connection = page.getByRole('dialog', {
    name: 'Подключение',
    exact: true,
  });
  await expect(connection).toBeVisible();
  await expect(connection.getByText('Задержка', {exact: true})).toBeVisible();
  await expect(
    connection.getByRole('img', {name: /^Последние задержки:/}),
  ).toBeVisible();
  await expect(connection.getByText('ID сессии', {exact: true})).toBeVisible();
  await expect(
    connection.getByText(/Live-|API проверки|Успешные проверки/),
  ).toHaveCount(0);
  await expect(connection.getByText(/^Поток /)).toHaveCount(0);
  const box = await connection.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(320);
  await page.screenshot({path: info.outputPath('connection.png')});
  await page.keyboard.press('Escape');
  const footer = page.getByRole('button', {name: 'О приложении', exact: true});
  await expect(footer).toHaveText(/^vote\.machine\. · [a-f0-9]{7}$/);
  await footer.click();
  const about = page.getByRole('dialog', {name: 'О приложении', exact: true});
  await expect(
    about.getByText('Mark Vodyanitskiy', {exact: true}),
  ).toBeVisible();
  await expect(about.getByRole('link', {name: 'mvodya.com'})).toHaveAttribute(
    'href',
    'https://mvodya.com',
  );
  await expect(about.getByText('Версия', {exact: true})).toBeVisible();
  await expect(
    about.getByRole('link', {name: 'GitHub', exact: true}),
  ).toHaveAttribute('href', 'https://github.com/mvodya/vote-machine');
  await expect(
    about.getByText(/Разработчик|Ссылка будет добавлена|Коммит приложения/),
  ).toHaveCount(0);
  await expect(about.locator('time')).toHaveAttribute(
    'datetime',
    /^\d{4}-\d{2}-\d{2}T/,
  );
  await page.screenshot({
    path: info.outputPath('mobile-about.png'),
    fullPage: true,
  });
});

test('admin link starts covered and tab navigation skips panel containers', async ({
  page,
}) => {
  const f = await votingFixture(page);
  await page.goto(`/rooms/${f.room.id}`);
  const settings = page.getByRole('tab', {name: 'Настройки', exact: true});
  await settings.click();
  const link = page.getByLabel('Административная ссылка', {exact: true});
  await expect(link).toHaveAttribute('type', 'password');
  await link.click();
  await expect(link).toHaveAttribute('type', 'text');
  await page
    .getByRole('button', {name: 'Скрыть административную ссылку'})
    .click();
  await expect(link).toHaveAttribute('type', 'password');
  await settings.focus();
  await page.keyboard.press('Tab');
  await expect(
    page.getByLabel('Название комнаты', {exact: true}),
  ).toBeFocused();
  await expect(
    page.getByRole('tabpanel', {name: 'Настройки', exact: true}),
  ).toHaveAttribute('tabindex', '-1');
});

test('room-zone date and time use common pickers and current-value buttons', async ({
  page,
}, info) => {
  const f = await votingFixture(page);
  await page.goto(`/rooms/${f.room.id}`);
  await page.getByRole('button', {name: 'Создать вопрос', exact: true}).click();
  await page
    .getByRole('menuitem', {name: 'Выбор варианта', exact: true})
    .click();
  await page.getByRole('tab', {name: 'Управление', exact: true}).click();
  await expect(
    page.getByRole('checkbox', {name: 'Отложенный старт', exact: true}),
  ).toHaveCSS('appearance', 'none');
  await page
    .getByRole('group', {name: 'Вид срока', exact: true})
    .getByRole('button', {name: 'Дата и время', exact: true})
    .click();
  const date = page.getByLabel('Дата закрытия', {exact: true});
  const time = page.getByLabel('Время закрытия', {exact: true});
  await expect(date).toHaveAttribute('type', 'text');
  await expect(time).toHaveAttribute('type', 'text');
  await page
    .getByRole('button', {
      name: 'Установить текущую дату: Дата закрытия',
      exact: true,
    })
    .click();
  await page
    .getByRole('button', {
      name: 'Установить текущее время: Время закрытия',
      exact: true,
    })
    .click();
  await expect(date).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
  await expect(time).toHaveValue(/^\d{2}:\d{2}:\d{2}$/);
  await page
    .getByRole('button', {name: 'Выбрать: Дата закрытия', exact: true})
    .click();
  const calendar = page.getByRole('dialog', {
    name: 'Выбрать: Дата закрытия',
    exact: true,
  });
  await expect(
    calendar.getByRole('button', {name: 'Следующий месяц'}),
  ).toBeVisible();
  await calendar.getByRole('button', {name: /^\d{4}-\d{2}-15$/}).click();
  await expect(date).toHaveValue(/-15$/);
  await page.keyboard.press('Escape');
  await page
    .getByRole('button', {name: 'Выбрать: Время закрытия', exact: true})
    .click();
  const picker = page.getByRole('dialog', {
    name: 'Выбрать: Время закрытия',
    exact: true,
  });
  await picker.getByLabel('Часы', {exact: true}).selectOption('17');
  await picker.getByLabel('Минуты', {exact: true}).selectOption('42');
  await picker.getByLabel('Секунды', {exact: true}).selectOption('13');
  await expect(time).toHaveValue('17:42:13');
  await page.screenshot({
    path: info.outputPath('date-time.png'),
    fullPage: true,
  });
});

test('question loading has placeholders and a new close fades once for five seconds', async ({
  page,
}) => {
  const f = await votingFixture(page);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/rooms/${f.room.id}/questions?*`, async (route) => {
    await held;
    await route.continue();
  });
  await page.goto(`/rooms/${f.room.id}`);
  await expect(
    page.getByRole('status', {name: 'Загружаем вопросы…', exact: true}),
  ).toBeVisible();
  release();
  const item = page.getByRole('listitem', {
    name: 'Choose a result',
    exact: true,
  });
  await expect(item).toBeVisible();
  await expect(item).toHaveCSS('border-bottom-left-radius', '0px');
  const row = await item.boundingBox();
  const title = await item.getByRole('heading').boundingBox();
  expect(title!.x - row!.x).toBeGreaterThanOrEqual(20);
  const closed = await page.request.post(
    `/api/rooms/${f.room.id}/questions/${f.question.id}/lifecycle`,
    {
      headers: {Origin: f.origin},
      data: {action: 'close', revision: f.question.revision},
    },
  );
  expect(closed.status()).toBe(200);
  await expect(item).toHaveAttribute('data-recently-closed', 'true');
  await expect(item).not.toHaveAttribute('data-recently-closed', 'true', {
    timeout: 8000,
  });
  let show!: () => void;
  const detail = new Promise<void>((resolve) => {
    show = resolve;
  });
  await page.route(
    `**/api/rooms/${f.room.id}/questions/${f.question.id}`,
    async (route) => {
      await detail;
      await route.continue();
    },
  );
  await item.getByRole('button', {name: 'Просмотреть', exact: true}).click();
  await expect(
    page.getByRole('status', {name: 'Открываем вопрос…', exact: true}),
  ).toBeVisible();
  show();
  await expect(
    page.getByRole('tab', {name: 'Редактирование', exact: true}),
  ).toBeVisible();
});

test('selected results are visible in the list and scroll into view on phones', async ({
  page,
}) => {
  const f = await votingFixture(page, {shareResults: true});
  for (let i = 0; i < 9; i++) {
    const created = await page.request.post(
      `/api/rooms/${f.room.id}/questions`,
      {
        headers: {Origin: f.origin},
        data: {
          content: `Extra ${i}`,
          choiceMode: 'single',
          minChoices: 1,
          maxChoices: 1,
          shareResults: false,
          publication: 'after_close',
          hideResultsUntilEnd: false,
          allowAnswerChange: false,
          anonymous: false,
          choices: [{content: 'A'}, {content: 'B'}],
        },
      },
    );
    expect(created.status()).toBe(201);
  }
  await page.setViewportSize({width: 390, height: 844});
  await page.goto(`/rooms/${f.room.id}`);
  await page.getByRole('tab', {name: 'Результаты', exact: true}).click();
  const selected = page.getByRole('button', {
    name: 'Результаты: Choose a result',
    exact: true,
  });
  await selected.click();
  await expect(selected).toHaveAttribute('aria-current', 'true');
  expect(
    await selected.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    ),
  ).not.toBe('rgba(0, 0, 0, 0)');
  const panel = page.getByRole('region', {name: 'Итоги вопроса', exact: true});
  await expect(panel.getByText('Ответы: 0', {exact: true})).toBeVisible();
  await expect
    .poll(async () => (await panel.boundingBox())!.y)
    .toBeLessThan(422);
  // Choosing the same result again must not replace it with endless loading
  await selected.click();
  await expect(panel.getByText('Ответы: 0', {exact: true})).toBeVisible();
});

test('twelve independent sessions load video and keep durable shared-link visit counts', async ({
  page,
  browser,
}, info) => {
  test.skip(
    !['mobile', 'webkit-mobile'].includes(info.project.name),
    'The same burst runs once per phone engine',
  );
  test.setTimeout(90000);
  const f = await votingFixture(page);
  const headers = {Origin: f.origin};
  const path = `/api/rooms/${f.room.id}`;
  const uploaded = await page.request.post(`${path}/assets`, {
    headers,
    multipart: {
      file: {
        name: process.env.TEST_BURST_VIDEO ? 'burst.mp4' : 'burst.webm',
        mimeType: process.env.TEST_BURST_VIDEO ? 'video/mp4' : 'video/webm',
        buffer: await readFile(
          process.env.TEST_BURST_VIDEO ||
            new URL('../fixtures/clip.webm', import.meta.url),
        ),
      },
    },
  });
  expect(uploaded.status()).toBe(201);
  const asset = await uploaded.json();
  const created = await page.request.post(`${path}/questions`, {
    headers,
    data: {
      content: `![Shared video](${asset.source} "width=320")`,
      choiceMode: 'single',
      minChoices: 1,
      maxChoices: 1,
      shareResults: false,
      publication: 'after_close',
      hideResultsUntilEnd: false,
      allowAnswerChange: false,
      anonymous: false,
      choices: [{content: 'Yes'}, {content: 'No'}],
    },
  });
  expect(created.status()).toBe(201);
  const {question} = await created.json();
  expect(
    (
      await page.request.post(`${path}/questions/${f.question.id}/lifecycle`, {
        headers,
        data: {action: 'close', revision: f.question.revision},
      })
    ).status(),
  ).toBe(200);
  expect(
    (
      await page.request.post(`${path}/questions/${question.id}/lifecycle`, {
        headers,
        data: {action: 'open', revision: question.revision},
      })
    ).status(),
  ).toBe(200);
  const links = await page.request.post(`${path}/links`, {
    headers,
    data: {mode: 'reusable', names: ['Shared video link']},
  });
  const {
    links: [link],
  } = await links.json();
  const {token} = await (
    await page.request.get(`${path}/links/${link.id}/secret`)
  ).json();
  await page.goto(`/rooms/${f.room.id}`);
  await page.getByRole('tab', {name: 'Респонденты', exact: true}).click();
  const row = page.getByRole('listitem', {
    name: 'Shared video link',
    exact: true,
  });
  await expect(row.getByText('Заходов: 0', {exact: true})).toBeVisible();
  const contexts = await Promise.all(
    Array.from({length: 12}, () =>
      browser.newContext({viewport: {width: 390, height: 844}}),
    ),
  );
  try {
    await Promise.all(
      contexts.map(async (context, index) => {
        const guest = await context.newPage();
        // One browser sees an injected temporary HTTP failure, not fake media data
        if (index === 0) {
          let failed = false;
          await guest.route(
            `**/api/vote/${link.id}/assets/${asset.id}*`,
            async (route) => {
              if (
                !failed &&
                route.request().method() === 'GET' &&
                !route.request().url().endsWith('/info')
              ) {
                failed = true;
                await route.fulfill({status: 503, body: ''});
              } else await route.continue();
            },
          );
        }
        await guest.goto(`${f.origin}/vote/${link.id}#key=${token}`);
        const video = guest.locator('video');
        await expect(
          guest.getByRole('radio', {name: 'Yes', exact: true}),
        ).toHaveCSS('appearance', 'none');
        await expect(video).toBeVisible();
        await expect
          .poll(
            () =>
              video.evaluate(
                (element) => (element as HTMLVideoElement).readyState,
              ),
            {timeout: 30000},
          )
          .toBeGreaterThanOrEqual(1);
        expect(
          await video.evaluate(
            (element) => (element as HTMLVideoElement).error?.code ?? null,
          ),
        ).toBeNull();
        const range = await guest.request.get(
          `/api/vote/${link.id}/assets/${asset.id}`,
          {headers: {Range: 'bytes=0-1'}},
        );
        expect(range.status()).toBe(206);
        expect((await range.body()).length).toBe(2);
        // An optional larger clip checks full concurrent streams, not only metadata
        if (process.env.TEST_BURST_VIDEO) {
          const full = await guest.request.get(
            `/api/vote/${link.id}/assets/${asset.id}`,
          );
          expect(full.status()).toBe(200);
          expect((await full.body()).length).toBeGreaterThan(1024 * 1024);
        }
        // Visiting again from the same browser reuses its stored session
        await guest.goto(`${f.origin}/vote/${link.id}#key=${token}`);
        await expect(guest.locator('video')).toBeVisible();
      }),
    );
    await expect(row.getByText('Заходов: 12', {exact: true})).toBeVisible({
      timeout: 15000,
    });
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test('multiple choice can submit an empty answer with a zero minimum', async ({
  page,
  browser,
}) => {
  const f = await votingFixture(page, {
    choiceMode: 'multiple',
    minChoices: 0,
    maxChoices: 2,
  });
  const device = await browser.newContext();
  try {
    const participant = await device.newPage();
    await participant.goto(f.url);
    await expect(
      participant.getByText('Выберите от 0 до 2 вариантов', {exact: true}),
    ).toBeVisible();
    const response = participant.waitForResponse(
      (reply) =>
        reply.url().includes('/answers/') &&
        reply.request().method() === 'POST',
    );
    await participant
      .getByRole('button', {name: 'Отправить ответ', exact: true})
      .click();
    const saved = await response;
    expect(saved.status()).toBe(200);
    expect((await saved.json()).answer.choices).toEqual([]);
    await expect(
      participant.getByText('Все вопросы пройдены', {exact: false}),
    ).toBeVisible();
  } finally {
    await device.close();
  }
});

test('long results leave room for the footer and unavailable labels follow the title inset', async ({
  page,
  browser,
}, info) => {
  const f = await votingFixture(page, {
    shareResults: true,
    publication: 'after_answer',
    choices: [{content: 'Long answer\n\n'.repeat(30)}, {content: 'No'}],
  });
  const device = await browser.newContext();
  try {
    const participant = await device.newPage();
    await participant.setViewportSize(page.viewportSize()!);
    await participant.goto(f.url);
    await participant.getByRole('radio').first().check();
    await participant
      .getByRole('button', {name: 'Отправить ответ', exact: true})
      .click();
    await participant
      .getByRole('tab', {name: 'Результаты', exact: true})
      .click();
    await participant
      .getByRole('button', {name: 'Результаты: Choose a result', exact: true})
      .click();
    const panel = participant.getByRole('region', {
      name: 'Итоги вопроса',
      exact: true,
    });
    await expect(panel.getByText('Ответы: 1', {exact: true})).toBeVisible();
    await participant.evaluate(() =>
      window.scrollTo(0, document.body.scrollHeight),
    );
    const resultBox = await panel.boundingBox();
    const footerBox = await participant.getByRole('contentinfo').boundingBox();
    expect(
      footerBox!.y - (resultBox!.y + resultBox!.height),
    ).toBeGreaterThanOrEqual(16);
    await participant.screenshot({path: info.outputPath('result-footer.png')});
    const hidden = await votingFixture(page, {hideResultsUntilEnd: true});
    await page.goto(`/rooms/${hidden.room.id}`);
    await page.getByRole('tab', {name: 'Результаты', exact: true}).click();
    const button = page.getByRole('button', {
      name: 'Результаты: Choose a result',
      exact: true,
    });
    await expect(button).toBeVisible();
    const aligned = await button.evaluate((element) => {
      const label = element.nextElementSibling!;
      const title = getComputedStyle(element);
      const note = getComputedStyle(label);
      return {
        title:
          element.getBoundingClientRect().right -
          parseFloat(title.paddingRight) -
          parseFloat(title.borderRightWidth),
        note:
          label.getBoundingClientRect().right - parseFloat(note.paddingRight),
      };
    });
    expect(Math.abs(aligned.title - aligned.note)).toBeLessThan(1);
  } finally {
    await device.close();
  }
});

test('new answers launch separate floating increments without moving the count', async ({
  page,
}, info) => {
  const f = await votingFixture(page);
  await page.goto(`/rooms/${f.room.id}`);
  const row = page.getByRole('listitem', {
    name: 'Choose a result',
    exact: true,
  });
  await expect(
    row.getByLabel('Количество ответов: 0', {exact: true}),
  ).toBeVisible();
  await expect(row.getByText('+1', {exact: true})).toHaveCount(0);
  const replies = await Promise.all(
    Array.from({length: 3}, () =>
      page.request.post(
        `/api/rooms/${f.room.id}/questions/${f.question.id}/manual`,
        {
          headers: {Origin: f.origin},
          data: {
            requestId: crypto.randomUUID(),
            questionRevision: f.question.revision,
            ballotRevision: '0',
            choices: [f.question.choices[0].id],
          },
        },
      ),
    ),
  );
  expect(replies.map((reply) => reply.status())).toEqual([200, 200, 200]);
  await expect(
    row.getByLabel('Количество ответов: 3', {exact: true}),
  ).toBeVisible();
  const bursts = row.getByText('+1', {exact: true});
  await expect(bursts).toHaveCount(3);
  const frames = await bursts.evaluateAll((labels) =>
    labels.map((label) => {
      const animation = label.getAnimations()[0];
      animation.pause();
      animation.currentTime = 0;
      return (animation.effect as KeyframeEffect).getKeyframes()[0].transform;
    }),
  );
  expect(new Set(frames).size).toBe(3);
  await page.screenshot({path: info.outputPath('answer-increments.png')});
  await bursts.evaluateAll((labels) =>
    labels.forEach((label) => label.getAnimations()[0].finish()),
  );
  await expect(bursts).toHaveCount(0);
  await page.emulateMedia({reducedMotion: 'reduce'});
  const next = await page.request.post(
    `/api/rooms/${f.room.id}/questions/${f.question.id}/manual`,
    {
      headers: {Origin: f.origin},
      data: {
        requestId: crypto.randomUUID(),
        questionRevision: f.question.revision,
        ballotRevision: '0',
        choices: [f.question.choices[0].id],
      },
    },
  );
  expect(next.status()).toBe(200);
  await expect(
    row.getByLabel('Количество ответов: 4', {exact: true}),
  ).toBeVisible();
  await expect(bursts).toHaveCount(0);
});
