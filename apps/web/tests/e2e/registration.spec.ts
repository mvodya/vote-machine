import {expect, test, type Page} from '@playwright/test';
import {votingFixture} from './voting-helpers';

// All registration checks use real group links and independent browser cookies
async function setup(page: Page, moderation = false) {
  const f = await votingFixture(page);
  const response = await page.request.post(`/api/rooms/${f.room.id}/links`, {
    headers: {Origin: f.origin},
    data: {
      mode: 'registration',
      names: ['Students'],
      requireModeration: moderation,
    },
  });
  expect(response.status()).toBe(201);
  const {
    links: [group],
  } = await response.json();
  const {token} = await (
    await page.request.get(`/api/rooms/${f.room.id}/links/${group.id}/secret`)
  ).json();
  return {...f, group, url: `${f.origin}/vote/${group.id}#key=${token}`};
}
async function enroll(page: Page, url: string, name = 'Alice Smith') {
  await page.goto(url);
  await page.getByLabel('Ваше имя', {exact: true}).fill(name);
  await page
    .getByRole('button', {name: 'Зарегистрироваться', exact: true})
    .click();
}
async function members(page: Page, room: string) {
  await page.goto(`/rooms/${room}`);
  await page.getByRole('tab', {name: 'Респонденты', exact: true}).click();
  await page
    .getByRole('listitem', {name: 'Students', exact: true})
    .getByRole('button', {name: 'Зарегистрированные', exact: true})
    .click();
}

test('registration creation uses group labels and exposes only its moderation setting', async ({
  page,
}) => {
  const f = await votingFixture(page);
  await page.goto(`/rooms/${f.room.id}`);
  await page.getByRole('tab', {name: 'Респонденты', exact: true}).click();
  await page
    .getByRole('button', {name: 'Добавить респондентов', exact: true})
    .click();
  await page.getByLabel('Режим ссылки', {exact: true}).selectOption('reusable');
  await expect(page.getByLabel('Имя группы', {exact: true})).toBeVisible();
  await page
    .getByLabel('Режим ссылки', {exact: true})
    .selectOption('registration');
  await expect(
    page.getByLabel('Разрешить просмотр прошлых прохождений', {exact: true}),
  ).toHaveCount(0);
  await page.getByLabel('Имя группы', {exact: true}).fill('Students');
  await page
    .getByLabel('Включить модерацию при регистрации', {exact: true})
    .check();
  await page.getByRole('button', {name: 'Создать ссылки', exact: true}).click();
  const row = page.getByRole('listitem', {name: 'Students', exact: true});
  await expect(row).toContainText('С регистрацией');
  await row
    .getByRole('button', {name: 'Изменить имя: Students', exact: true})
    .click();
  await expect(page.getByLabel('Имя группы', {exact: true})).toHaveValue(
    'Students',
  );
  await expect(
    page.getByLabel('Включить модерацию при регистрации', {exact: true}),
  ).toBeChecked();
});

test('registration reopens the same browser person and keeps individual answers', async ({
  page,
  browser,
}) => {
  const f = await setup(page);
  const context = await browser.newContext({locale: 'ru-RU'});
  try {
    const student = await context.newPage();
    await enroll(student, f.url);
    await expect(
      student.getByRole('radio', {name: 'Yes', exact: true}),
    ).toBeVisible();
    await student.getByRole('radio', {name: 'Yes', exact: true}).check();
    await student
      .getByRole('button', {name: 'Отправить ответ', exact: true})
      .click();
    await expect(
      student.getByText('Все вопросы пройдены', {exact: true}),
    ).toBeVisible();
    await student.goto(f.url);
    await expect(
      student.getByText('Все вопросы пройдены', {exact: true}),
    ).toBeVisible();
    await expect(student.getByLabel('Ваше имя', {exact: true})).toHaveCount(0);
    await student
      .getByRole('tab', {name: 'Список вопросов', exact: true})
      .click();
    await student
      .getByRole('button', {name: 'Choose a result', exact: true})
      .click();
    await expect(
      student.getByRole('radio', {name: 'Yes', exact: true}),
    ).toBeChecked();
    const list = await page.request.get(
      `/api/rooms/${f.room.id}/links/${f.group.id}/members`,
    );
    expect((await list.json()).members).toHaveLength(1);
    const result = await (
      await page.request.get(
        `/api/rooms/${f.room.id}/results?question=${f.question.id}`,
      )
    ).json();
    expect(result.result.people[0].name).toBe('Alice Smith');
    expect(result.result.people[0].groupName).toBe('Students');
  } finally {
    await context.close();
  }
});

test('registration moderation rejects resubmits approves and blocks a person live', async ({
  page,
  browser,
}) => {
  const f = await setup(page, true);
  const context = await browser.newContext({locale: 'ru-RU'});
  try {
    const student = await context.newPage();
    await enroll(student, f.url, 'Wrong name');
    await expect(
      student.getByText('Ожидаем подтверждения', {exact: true}),
    ).toBeVisible();
    await expect(
      student.getByRole('radio', {name: 'Yes', exact: true}),
    ).toHaveCount(0);
    await members(page, f.room.id);
    await page.getByRole('tab', {name: /^Ожидающие подтверждения/}).click();
    await page
      .getByRole('listitem', {name: 'Wrong name', exact: true})
      .getByRole('button', {name: 'Отказать', exact: true})
      .click();
    await expect(
      student.getByText('В регистрации отказано, укажите другое имя', {
        exact: true,
      }),
    ).toBeVisible();
    await student.getByLabel('Ваше имя', {exact: true}).fill('Correct name');
    await student
      .getByRole('button', {name: 'Зарегистрироваться', exact: true})
      .click();
    const pending = page.getByRole('listitem', {
      name: 'Correct name',
      exact: true,
    });
    await pending
      .getByRole('button', {name: 'Подтвердить', exact: true})
      .click();
    await expect(
      student.getByRole('radio', {name: 'Yes', exact: true}),
    ).toBeVisible();
    await page
      .getByRole('tab', {name: 'Зарегистрированные', exact: true})
      .click();
    await page
      .getByRole('button', {name: 'Заблокировать: Correct name', exact: true})
      .click();
    await expect(
      student.getByText('Доступ заблокирован', {exact: true}),
    ).toBeVisible();
    await expect(
      student.getByRole('radio', {name: 'Yes', exact: true}),
    ).toHaveCount(0);
    await page
      .getByRole('button', {name: 'Разблокировать: Correct name', exact: true})
      .click();
    await expect(
      student.getByRole('radio', {name: 'Yes', exact: true}),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});

test('registration recovery binds another device and a revoked group keeps its members', async ({
  page,
  browser,
}) => {
  const f = await setup(page);
  const first = await browser.newContext({locale: 'ru-RU'});
  const second = await browser.newContext({locale: 'ru-RU'});
  try {
    const student = await first.newPage();
    await enroll(student, f.url);
    await expect(
      student.getByRole('radio', {name: 'Yes', exact: true}),
    ).toBeVisible();
    const list = await (
      await page.request.get(
        `/api/rooms/${f.room.id}/links/${f.group.id}/members`,
      )
    ).json();
    const member = list.members[0];
    const {token} = await (
      await page.request.get(
        `/api/rooms/${f.room.id}/links/${f.group.id}/members/${member.id}/secret`,
      )
    ).json();
    const recovery = `${f.origin}/vote/${f.group.id}#member=${member.id}&key=${token}`;
    const other = await second.newPage();
    await other.goto(recovery);
    await expect(
      other.getByRole('radio', {name: 'Yes', exact: true}),
    ).toBeVisible();
    await expect(other.getByLabel('Ваше имя', {exact: true})).toHaveCount(0);
    await members(page, f.room.id);
    await expect(
      page.getByText('Открыто на 2 устройствах', {exact: true}),
    ).toBeVisible();
    const qr = await page.request.get(
      `/api/rooms/${f.room.id}/links/${f.group.id}/members/${member.id}/qr`,
    );
    expect(qr.ok()).toBe(true);
    expect(qr.headers()['content-type']).toContain('image/png');
    await page.request.patch(`/api/rooms/${f.room.id}/links/${f.group.id}`, {
      headers: {Origin: f.origin},
      data: {action: 'revoke'},
    });
    await student.reload();
    await expect(
      student.getByRole('radio', {name: 'Yes', exact: true}),
    ).toBeVisible();
    const extra = await browser.newContext({locale: 'ru-RU'});
    try {
      const newcomer = await extra.newPage();
      await newcomer.goto(f.url);
      await expect(
        newcomer.getByText('Ссылка недействительна', {exact: true}),
      ).toBeVisible();
    } finally {
      await extra.close();
    }
    await other.goto(f.url);
    await expect(
      other.getByRole('radio', {name: 'Yes', exact: true}),
    ).toBeVisible();
  } finally {
    await first.close();
    await second.close();
  }
});

test('attendance call plays while muted and its modal cannot close early', async ({
  page,
  browser,
}) => {
  const f = await setup(page);
  const context = await browser.newContext({locale: 'ru-RU'});
  try {
    await context.addInitScript(() => {
      const state = window as unknown as {attentionStarts: number};
      state.attentionStarts = 0;
      const start = AudioBufferSourceNode.prototype.start;
      AudioBufferSourceNode.prototype.start = function (
        when = 0,
        offset = 0,
        duration?: number,
      ) {
        state.attentionStarts++;
        if (duration === undefined) start.call(this, when, offset);
        else start.call(this, when, offset, duration);
      };
    });
    const student = await context.newPage();
    await enroll(student, f.url);
    await expect(
      student.getByRole('radio', {name: 'Yes', exact: true}),
    ).toBeVisible();
    await expect(
      student.getByRole('button', {name: 'Включить звуки', exact: true}),
    ).toBeVisible();
    await members(page, f.room.id);
    await page
      .getByRole('button', {name: 'Вызов: Alice Smith', exact: true})
      .click();
    const alert = student.getByRole('alertdialog', {
      name: 'Администратор вызывает вас',
      exact: true,
    });
    await expect(alert).toBeVisible();
    await student.keyboard.press('Escape');
    await expect(alert).toBeVisible();
    await expect
      .poll(() =>
        student.evaluate(
          () =>
            (window as unknown as {attentionStarts: number}).attentionStarts,
        ),
      )
      .toBe(1);
    await expect(alert).toHaveCount(0, {timeout: 4500});
    await expect(
      student.getByRole('button', {name: 'Включить звуки', exact: true}),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});

test('registration roster shows pending work, supports rename and clears hidden device presence', async ({
  page,
  browser,
}, testInfo) => {
  const f = await setup(page, true);
  const context = await browser.newContext({locale: 'ru-RU'});
  try {
    const student = await context.newPage();
    await enroll(student, f.url, 'Alice');
    await expect(
      student.getByText('Ожидаем подтверждения', {exact: true}),
    ).toBeVisible();
    await page.goto(`/rooms/${f.room.id}`);
    const respondents = page.getByRole('tab', {
      name: 'Респонденты',
      exact: true,
    });
    await respondents.click();
    const group = page.getByRole('listitem', {name: 'Students', exact: true});
    await expect(
      group.getByText('Ожидают подтверждения: 1', {exact: true}),
    ).toBeVisible();
    const open = group.getByRole('button', {
      name: 'Зарегистрированные',
      exact: true,
    });
    await expect(open).toHaveText('');
    await expect(
      group.getByRole('button', {name: 'Скопировать ссылку', exact: true}),
    ).toHaveText('');
    await open.click();
    await expect(
      page.getByText('Зарегистрировано: 0', {exact: true}),
    ).toBeVisible();
    const pendingTab = page.getByRole('tab', {
      name: 'Ожидающие подтверждения (1)',
      exact: true,
    });
    await expect(pendingTab).toHaveClass(/bg-warning/);
    await page
      .getByRole('button', {name: 'Подтвердить ожидающих', exact: true})
      .click();
    await page.getByRole('button', {name: 'Отказать', exact: true}).click();
    await expect(student.getByLabel('Ваше имя', {exact: true})).toBeVisible();
    await page
      .getByRole('tab', {name: 'Зарегистрированные', exact: true})
      .click();
    await expect(
      page.getByRole('listitem', {name: 'Alice', exact: true}),
    ).toHaveCount(0);
    await student.getByLabel('Ваше имя', {exact: true}).fill('Alice Smith');
    await student
      .getByRole('button', {name: 'Зарегистрироваться', exact: true})
      .click();
    await page
      .getByRole('button', {name: 'Подтвердить ожидающих', exact: true})
      .click();
    await page.getByRole('button', {name: 'Подтвердить', exact: true}).click();
    await page
      .getByRole('tab', {name: 'Зарегистрированные', exact: true})
      .click();
    await expect(
      page.getByText('Зарегистрировано: 1', {exact: true}),
    ).toBeVisible();
    await page
      .getByRole('button', {name: 'Изменить имя: Alice Smith', exact: true})
      .click();
    await page
      .getByLabel('Имя респондента', {exact: true})
      .fill('Alice Cooper');
    await page.getByRole('button', {name: 'Сохранить', exact: true}).click();
    const person = page.getByRole('listitem', {
      name: 'Alice Cooper',
      exact: true,
    });
    await expect(person).toBeVisible();
    await expect(
      student.getByText('Alice Cooper · Students', {exact: true}),
    ).toBeVisible();
    await expect(person.getByText(/^Смотрит:/)).toBeVisible();
    const bell = person.getByRole('button', {
      name: 'Вызов: Alice Cooper',
      exact: true,
    });
    await bell.click();
    await expect(bell).toHaveClass(/alert/);
    await expect(page.getByText('Вызов отправлен', {exact: true})).toHaveCount(
      0,
    );
    await expect(bell).not.toHaveClass(/alert/, {timeout: 5000});
    // Hidden tabs stop both their group lease and their current question view
    await student.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(person.getByText('Не в сети', {exact: true})).toBeVisible();
    await expect(person.getByText(/^Смотрит:/)).toHaveCount(0);
    await student.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'visible',
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(person.getByText(/^Смотрит:/)).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath('registration-roster.png'),
      fullPage: true,
    });
    await respondents.click();
    await expect(
      page.getByRole('heading', {name: 'Респонденты', exact: true}),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', {name: 'Students', exact: true}),
    ).toBeVisible();
    await expect(
      page.getByText('Зарегистрировано: 1', {exact: true}),
    ).toHaveCount(0);
  } finally {
    await context.close();
  }
});

// A real page exit must clear presence without waiting for the stale lease timeout
test('leaving a registration page clears its online status', async ({
  page,
  browser,
}) => {
  const f = await setup(page);
  const context = await browser.newContext({locale: 'ru-RU'});
  try {
    const student = await context.newPage();
    await enroll(student, f.url);
    await expect(
      student.getByRole('radio', {name: 'Yes', exact: true}),
    ).toBeVisible();
    await members(page, f.room.id);
    const person = page.getByRole('listitem', {
      name: 'Alice Smith',
      exact: true,
    });
    await expect(person.getByText(/^Смотрит:/)).toBeVisible();
    await student.goto('about:blank');
    await expect(person.getByText('Не в сети', {exact: true})).toBeVisible();
    await expect(person.getByText(/^Смотрит:/)).toHaveCount(0);
  } finally {
    await context.close();
  }
});

// Both moderation actions need visible hover colors in each theme
test('moderation buttons have green and red hover backgrounds', async ({
  page,
  browser,
}) => {
  const f = await setup(page, true);
  const context = await browser.newContext({locale: 'ru-RU'});
  try {
    const student = await context.newPage();
    await enroll(student, f.url);
    await members(page, f.room.id);
    await page
      .getByRole('button', {name: 'Подтвердить ожидающих', exact: true})
      .click();
    for (const theme of ['light', 'dark']) {
      await page.evaluate(
        (value) => (document.documentElement.dataset.theme = value),
        theme,
      );
      for (const name of ['Подтвердить', 'Отказать']) {
        const button = page.getByRole('button', {name, exact: true});
        await button.hover();
        await expect
          .poll(() =>
            button.evaluate((element, approve) => {
              // Read rendered colors so CSS transitions and both themes are checked
              const canvas = document.createElement('canvas');
              canvas.width = canvas.height = 1;
              const paint = canvas.getContext('2d')!;
              const pixel = (color: string) => {
                paint.clearRect(0, 0, 1, 1);
                paint.fillStyle = color;
                paint.fillRect(0, 0, 1, 1);
                return paint.getImageData(0, 0, 1, 1).data;
              };
              const style = getComputedStyle(element);
              const background = pixel(style.backgroundColor);
              const text = pixel(style.color);
              const colored = approve
                ? background[1] > background[0] + 25 &&
                  background[1] > background[2] + 15
                : background[0] > background[1] + 60 &&
                  background[0] > background[2] + 30;
              return (
                colored &&
                background[3] === 255 &&
                text[0] > 240 &&
                text[1] > 240 &&
                text[2] > 240
              );
            }, name === 'Подтвердить'),
          )
          .toBe(true);
      }
    }
  } finally {
    await context.close();
  }
});

test('registration group results have a separate section and deletion follows revocation', async ({
  page,
  browser,
}) => {
  const f = await setup(page);
  const context = await browser.newContext({locale: 'ru-RU'});
  try {
    const student = await context.newPage();
    await enroll(student, f.url, 'Group voter');
    await student.getByRole('radio', {name: 'Yes', exact: true}).check();
    await student
      .getByRole('button', {name: 'Отправить ответ', exact: true})
      .click();
    await page.goto(`/rooms/${f.room.id}`);
    await page.getByRole('tab', {name: 'Результаты', exact: true}).click();
    const summary = page.getByRole('region', {
      name: 'Общие результаты',
      exact: true,
    });
    // A group appears once, outside the other source charts
    const chart = (name: string) =>
      summary.locator('section').filter({
        has: page.getByRole('heading', {name, exact: true}),
      });
    const registered = chart('С регистрацией');
    await expect(registered.getByText('Students', {exact: true})).toBeVisible();
    await expect(registered.getByRole('listitem')).toHaveText('Students1');
    await expect(summary.getByText('Students', {exact: true})).toHaveCount(1);
    await expect(summary.getByText('Group voter', {exact: true})).toHaveCount(
      0,
    );
    await expect(
      chart('Многоразовые ссылки').getByText('Нет ответов'),
    ).toBeVisible();
    await expect(
      chart('Источники ответов').getByText('Нет ответов'),
    ).toBeVisible();
    await page.getByRole('tab', {name: 'Респонденты', exact: true}).click();
    const group = page.getByRole('listitem', {name: 'Students', exact: true});
    const remove = group.getByRole('button', {
      name: 'Удалить ссылку: Students',
      exact: true,
    });
    await expect(remove).toHaveCount(0);
    await group
      .getByRole('button', {name: 'Отозвать ссылку: Students', exact: true})
      .click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText(
      'зарегистрированные участники сохранят доступ',
    );
    await dialog.getByRole('button', {name: 'Отозвать', exact: true}).click();
    await remove.click();
    await expect(dialog).toContainText(
      'анонимные ответы останутся в результатах',
    );
    await dialog.getByRole('button', {name: 'Удалить', exact: true}).click();
    await expect(group).toHaveCount(0);
    await expect(
      student.getByText('Ссылка недействительна', {exact: true}),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});
