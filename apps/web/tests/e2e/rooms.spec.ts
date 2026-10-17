import {expect, test, type Page} from '@playwright/test';

// Create a room and read its link from settings
async function createRoom(page: Page, name: string) {
  await page.goto('/');
  await page.getByLabel('Название комнаты', {exact: true}).fill(name);
  await page
    .getByRole('button', {name: 'Создать комнату', exact: true})
    .click();
  await expect(page).toHaveURL(/\/rooms\/[0-9a-f-]+(?:#.*)?$/);
  await expect(
    page.getByRole('heading', {name: name || 'Новая комната', exact: true}),
  ).toBeVisible();
  await page.getByRole('tab', {name: 'Настройки', exact: true}).click();
  const link = await page
    .getByLabel('Административная ссылка', {exact: true})
    .inputValue();
  expect(link).toMatch(/\/rooms\/[0-9a-f-]+#admin=[0-9a-f]{64}$/);
  expect(new URL(page.url()).hash).toBe('');
  return link;
}

test('create, save the link, rename and reopen after reload', async ({
  page,
  context,
}) => {
  const link = await createRoom(page, 'Совет дома');
  const id = new URL(link).pathname.split('/').at(-1)!;
  const cookies = await context.cookies(
    `${new URL(link).origin}/api/rooms/${id}`,
  );
  const session = cookies.find((cookie) => cookie.name.startsWith('vm_room_'))!;
  expect(session.httpOnly).toBe(true);
  expect(session.expires).toBeGreaterThan(
    Date.now() / 1000 + 365 * 24 * 60 * 60,
  );
  expect(session.sameSite).toBe('Strict');
  expect(session.path).toBe('/');
  expect(await page.evaluate(() => document.cookie)).not.toContain(
    session.value,
  );
  await page
    .getByLabel('Название комнаты', {exact: true})
    .fill('Новое название');
  await page.getByRole('button', {name: 'Сохранить название'}).click();
  await expect(page.getByRole('status')).toHaveText('Название сохранено');
  await expect(
    page.getByRole('heading', {name: 'Новое название', exact: true}),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('heading', {name: 'Новое название', exact: true}),
  ).toBeVisible();
  await page.getByRole('tab', {name: 'Настройки', exact: true}).click();
  await expect(
    page.getByLabel('Административная ссылка', {exact: true}),
  ).toHaveValue(link);
  expect(
    await page.evaluate(() => ({
      local: localStorage.length,
      session: sessionStorage.length,
    })),
  ).toEqual({local: 0, session: 0});
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test('one link works in two tabs and another device without replacing sessions', async ({
  page,
  context,
  browser,
}) => {
  const link = await createRoom(page, 'Общая комната');
  const tab = await context.newPage();
  const device = await browser.newContext();
  try {
    const other = await device.newPage();
    for (const target of [tab, other]) {
      await target.goto(link);
      await expect(
        target.getByRole('heading', {name: 'Общая комната', exact: true}),
      ).toBeVisible();
      expect(new URL(target.url()).hash).toBe('');
    }
    await other.getByRole('tab', {name: 'Настройки', exact: true}).click();
    await other
      .getByLabel('Название комнаты', {exact: true})
      .fill('На другом устройстве');
    await other.getByRole('button', {name: 'Сохранить название'}).click();
    await expect(other.getByRole('status')).toHaveText('Название сохранено');
    for (const target of [page, tab]) {
      await target.reload();
      await expect(
        target.getByRole('heading', {
          name: 'На другом устройстве',
          exact: true,
        }),
      ).toBeVisible();
    }
  } finally {
    await device.close();
    await tab.close();
  }
});

test('two rooms retain separate cookies and cannot use each others link', async ({
  page,
  context,
  browser,
}) => {
  const first = await createRoom(page, 'Первая');
  const second = await createRoom(page, 'Вторая');
  const firstId = new URL(first).pathname.split('/').at(-1)!;
  const secondId = new URL(second).pathname.split('/').at(-1)!;
  const cookies = await context.cookies();
  expect(
    cookies.filter((cookie) => cookie.name.startsWith('vm_room_')),
  ).toHaveLength(2);
  await page.goto(new URL(first).pathname);
  await expect(
    page.getByRole('heading', {name: 'Первая', exact: true}),
  ).toBeVisible();
  const visitor = await browser.newContext();
  try {
    const anonymous = await visitor.newPage();
    await anonymous.goto(new URL(first).origin + `/rooms/${firstId}`);
    await expect(
      anonymous.getByRole('heading', {name: 'Нет доступа к комнате'}),
    ).toBeVisible();
    await anonymous.goto(
      `${new URL(second).origin}/rooms/${secondId}${new URL(first).hash}`,
    );
    await expect(
      anonymous.getByRole('heading', {name: 'Нет доступа к комнате'}),
    ).toBeVisible();
    expect(new URL(anonymous.url()).hash).toBe('');
    const forbidden = await visitor.request.patch(`/api/rooms/${secondId}`, {
      headers: {Origin: new URL(second).origin},
      data: {name: 'hacked'},
    });
    expect(forbidden.status()).toBe(401);
  } finally {
    await visitor.close();
  }
  await page.goto(new URL(second).pathname);
  await expect(
    page.getByRole('heading', {name: 'Вторая', exact: true}),
  ).toBeVisible();
});

test('secret is absent from request URLs and referers and foreign writes are rejected', async ({
  page,
}) => {
  const seen: {url: string; referer: string}[] = [];
  page.on('request', (request) =>
    seen.push({url: request.url(), referer: request.headers().referer ?? ''}),
  );
  const link = await createRoom(page, 'Приватная');
  const url = new URL(link);
  const token = new URLSearchParams(url.hash.slice(1)).get('admin')!;
  expect(JSON.stringify(seen)).not.toContain(token);
  const path = `/api${url.pathname}`;
  const response = await page.request.get(path);
  expect(response.status()).toBe(200);
  expect(response.headers()['cache-control']).toContain('no-store');
  expect(JSON.stringify(await response.json())).not.toContain(token);
  const blocked = await page.request.patch(path, {
    headers: {Origin: 'https://foreign.test'},
    data: {name: 'hacked'},
  });
  expect(blocked.status()).toBe(403);
  const missing = await page.request.post('/api/rooms', {
    data: {name: 'hacked'},
  });
  expect(missing.status()).toBe(403);
});

test('default room name and a failed exchange can be retried without restoring the fragment', async ({
  page,
}) => {
  const link = await createRoom(page, '');
  const path = new URL(link).pathname;
  await page.route(`**/api${path}/session`, (route) =>
    route.fulfill({status: 503, json: {error: 'Unavailable'}}),
  );
  await page.goto(link);
  await expect(
    page.getByRole('heading', {name: 'Не удалось открыть комнату'}),
  ).toBeVisible();
  expect(new URL(page.url()).hash).toBe('');
  await page.unroute(`**/api${path}/session`);
  await page.getByRole('button', {name: 'Попробовать снова'}).click();
  await expect(
    page.getByRole('heading', {name: 'Новая комната', exact: true}),
  ).toBeVisible();
});

test('a saved link can unlock the same page after access was denied', async ({
  page,
  browser,
}) => {
  const link = await createRoom(page, 'Повторное открытие');
  const device = await browser.newContext();
  try {
    const other = await device.newPage();
    const url = new URL(link);
    await other.goto(url.origin + url.pathname);
    await expect(
      other.getByRole('heading', {name: 'Нет доступа к комнате'}),
    ).toBeVisible();
    await other.goto(link);
    await expect(
      other.getByRole('heading', {name: 'Повторное открытие', exact: true}),
    ).toBeVisible();
    expect(new URL(other.url()).hash).toBe('');
  } finally {
    await device.close();
  }
});

test('home entry opens a saved link and supports cookie access without a secret', async ({
  page,
  browser,
}) => {
  const link = await createRoom(page, 'Вход с главной');
  const device = await browser.newContext();
  try {
    const other = await device.newPage();
    await other.goto('/');
    await other.getByRole('button', {name: 'Войти', exact: true}).click();
    await other.getByLabel('Ссылка на комнату').fill(link);
    await other.getByRole('button', {name: 'Войти в комнату'}).click();
    await expect(
      other.getByRole('heading', {name: 'Вход с главной', exact: true}),
    ).toBeVisible();
    expect(new URL(other.url()).hash).toBe('');
    await other.goto('/');
    await other.getByRole('button', {name: 'Войти', exact: true}).click();
    await other
      .getByRole('button', {name: 'Войти по ссылке', exact: true})
      .click();
    await other.getByLabel('Ссылка на комнату').fill(new URL(link).pathname);
    await other.getByRole('button', {name: 'Войти в комнату'}).click();
    await expect(
      other.getByRole('heading', {name: 'Вход с главной', exact: true}),
    ).toBeVisible();
  } finally {
    await device.close();
  }
});

test('room shell has empty sections and settings without question or respondent actions', async ({
  page,
}, info) => {
  await createRoom(page, 'Заседание совета');
  await page.getByRole('tab', {name: 'Вопросы', exact: true}).click();
  await expect(page.getByText('Вопросов пока нет')).toBeVisible();
  await expect(
    page.getByRole('button', {name: 'Создать вопрос'}),
  ).toBeDisabled();
  await page.getByRole('tab', {name: 'Респонденты', exact: true}).click();
  await expect(page.getByText('Респондентов пока нет')).toBeVisible();
  await page.getByRole('tab', {name: 'Результаты', exact: true}).click();
  await expect(page.getByText('Результатов пока нет')).toBeVisible();
  await page.getByRole('tab', {name: 'Вопросы', exact: true}).click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({path: info.outputPath('room.png'), fullPage: true});
});

test('recent rooms use cached names, reorder on entry and can be removed and restored by link', async ({
  page,
  browser,
}) => {
  const first = await createRoom(page, 'Первая комната');
  const second = await createRoom(page, 'Вторая комната');
  const secondId = new URL(second).pathname.split('/').at(-1)!;
  const device = await browser.newContext();
  try {
    const other = await device.newPage();
    await other.goto(second);
    await other.getByRole('tab', {name: 'Настройки', exact: true}).click();
    await other
      .getByLabel('Название комнаты', {exact: true})
      .fill('Новое имя второй');
    await other.getByRole('button', {name: 'Сохранить название'}).click();
    await expect(other.getByRole('status')).toHaveText('Название сохранено');
    await page.goto('/');
    await page.getByRole('button', {name: 'Войти', exact: true}).click();
    await expect(page.locator('.recent-rooms li a')).toHaveText([
      'Вторая комната',
      'Первая комната',
    ]);
    await page.getByRole('link', {name: 'Первая комната', exact: true}).click();
    await expect(
      page.getByRole('heading', {name: 'Первая комната', exact: true}),
    ).toBeVisible();
    await page.goto('/');
    await page.getByRole('button', {name: 'Войти', exact: true}).click();
    await expect(page.locator('.recent-rooms li a')).toHaveText([
      'Первая комната',
      'Вторая комната',
    ]);
    await page.getByRole('link', {name: 'Вторая комната', exact: true}).click();
    await expect(
      page.getByRole('heading', {name: 'Новое имя второй', exact: true}),
    ).toBeVisible();
    await page.goto('/');
    await page.getByRole('button', {name: 'Войти', exact: true}).click();
    await expect(page.locator('.recent-rooms li a')).toHaveText([
      'Новое имя второй',
      'Первая комната',
    ]);
    await page
      .getByRole('button', {name: 'Войти по ссылке', exact: true})
      .click();
    await expect(page.getByLabel('Ссылка на комнату')).toBeVisible();
    await page
      .getByRole('button', {
        name: 'Показать список ранее использованных комнат',
      })
      .click();
    await page
      .getByRole('button', {name: 'Убрать комнату Новое имя второй из списка'})
      .click();
    await expect(page.locator('.recent-rooms li a')).toHaveText([
      'Первая комната',
    ]);
    await other.reload();
    await expect(
      other.getByRole('heading', {name: 'Новое имя второй', exact: true}),
    ).toBeVisible();
    expect((await page.request.get(`/api/rooms/${secondId}`)).status()).toBe(
      401,
    );
    await page
      .getByRole('button', {name: 'Войти по ссылке', exact: true})
      .click();
    await page.getByLabel('Ссылка на комнату').fill(second);
    await page.getByRole('button', {name: 'Войти в комнату'}).click();
    await expect(
      page.getByRole('heading', {name: 'Новое имя второй', exact: true}),
    ).toBeVisible();
    await page.goto('/');
    await page.getByRole('button', {name: 'Войти', exact: true}).click();
    await expect(page.locator('.recent-rooms li a')).toHaveText([
      'Новое имя второй',
      'Первая комната',
    ]);
    await page
      .getByRole('button', {name: 'Убрать комнату Новое имя второй из списка'})
      .click();
    await page
      .getByRole('button', {name: 'Убрать комнату Первая комната из списка'})
      .click();
    await expect(page.getByLabel('Ссылка на комнату')).toBeVisible();
    await expect(
      page.getByRole('button', {
        name: 'Показать список ранее использованных комнат',
      }),
    ).toHaveCount(0);
    expect(first).not.toBe(second);
  } finally {
    await device.close();
  }
});

test('a non-admin link entered on home opens directly', async ({page}) => {
  await page.route('**/vote/example*', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<h1>Participant destination</h1>',
    }),
  );
  await page.goto('/');
  await page.getByRole('button', {name: 'Войти', exact: true}).click();
  await page
    .getByLabel('Ссылка на комнату')
    .fill(`${new URL(page.url()).origin}/vote/example#token=sample`);
  await page.getByRole('button', {name: 'Войти в комнату'}).click();
  await expect(page).toHaveURL(/\/vote\/example#token=sample$/);
});

test('copy link button keeps the Lucide icon aligned with its label', async ({
  page,
}, info) => {
  const link = await createRoom(page, 'Настройки комнаты');
  const button = page.getByRole('button', {
    name: 'Скопировать ссылку',
    exact: true,
  });
  const geometry = await button.evaluate((element) => {
    const icon = element.querySelector('svg')!.getBoundingClientRect();
    const text = [...element.childNodes].find(
      (node) =>
        node.nodeType === Node.TEXT_NODE &&
        node.textContent?.includes('Скопировать ссылку'),
    )!;
    // Measure the visible label next to the icon
    const range = document.createRange();
    range.selectNodeContents(text);
    const label = range.getBoundingClientRect();
    return {
      iconWidth: icon.width,
      iconHeight: icon.height,
      offset: Math.abs(icon.y + icon.height / 2 - label.y - label.height / 2),
      gap: label.x - icon.right,
    };
  });
  expect(geometry.iconWidth).toBe(16);
  expect(geometry.iconHeight).toBe(16);
  expect(geometry.offset).toBeLessThanOrEqual(1.5);
  expect(geometry.gap).toBeGreaterThanOrEqual(7);
  const field = await page
    .getByLabel('Административная ссылка', {exact: true})
    .boundingBox();
  const copyButton = await button.boundingBox();
  expect(copyButton!.y - field!.y - field!.height).toBeGreaterThanOrEqual(16);
  // Test copying without changing the system clipboard
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          (window as Window & {copiedLink?: string}).copiedLink = value;
        },
      },
    });
  });
  await button.click();
  await expect(page.getByRole('status')).toHaveText('Ссылка скопирована');
  expect(
    await page.evaluate(
      () => (window as Window & {copiedLink?: string}).copiedLink,
    ),
  ).toBe(link);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await button.screenshot({path: info.outputPath('copy-button.png')});
  await page.screenshot({
    path: info.outputPath('settings.png'),
    fullPage: true,
    mask: [page.getByLabel('Административная ссылка', {exact: true})],
    maskColor: '#eef1e8',
  });
});
