import {readFile} from 'node:fs/promises';
import {expect, test, type Page} from '@playwright/test';

// Open a fresh room with its own admin session
async function setup(page: Page) {
  await page.goto('/');
  await page
    .getByLabel('Название комнаты', {exact: true})
    .fill('Links browser');
  await page
    .getByRole('button', {name: 'Создать комнату', exact: true})
    .click();
  await expect(
    page.getByRole('heading', {name: 'Links browser', exact: true}),
  ).toBeVisible();
  await page.getByRole('tab', {name: 'Респонденты', exact: true}).click();
  await expect(page.getByText('Респондентов пока нет')).toBeVisible();
  return new URL(page.url()).pathname.split('/').at(-1)!;
}
// Keep copied secrets inside the test page
async function clipboard(page: Page) {
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          sessionStorage.setItem('test-copy', value);
        },
      },
    });
  });
}
// Read the text captured by the test clipboard
async function copied(page: Page) {
  return page.evaluate(() => sessionStorage.getItem('test-copy') ?? '');
}

test('personal link, rename, repeated copy, revoke and reissue across devices', async ({
  page,
  browser,
}, info) => {
  const roomId = await setup(page);
  await clipboard(page);
  await page
    .getByRole('button', {name: 'Добавить респондентов', exact: true})
    .click();
  await page.getByLabel('Имя респондента', {exact: true}).fill('Alice');
  await page.getByRole('button', {name: 'Создать ссылки', exact: true}).click();
  const alice = page.getByRole('listitem', {name: 'Alice', exact: true});
  await expect(alice).toBeVisible();
  await alice
    .getByRole('button', {name: 'Скопировать ссылку', exact: true})
    .click();
  await expect
    .poll(() => copied(page))
    .toMatch(/\/vote\/[0-9a-f-]+#key=[a-f0-9]{64}$/);
  const first = await copied(page);
  await alice
    .getByRole('button', {name: 'Скопировать ссылку', exact: true})
    .click();
  await expect.poll(() => copied(page)).toBe(first);
  const device = await browser.newContext();
  const participant = await device.newPage();
  try {
    await participant.goto(first);
    await expect(
      participant.getByRole('heading', {name: 'Ожидание вопросов'}),
    ).toBeVisible();
    expect(new URL(participant.url()).hash).toBe('');
    const session = (await device.cookies()).find((cookie) =>
      cookie.name.startsWith('vm_vote_'),
    )!;
    expect(session.httpOnly).toBe(true);
    expect(session.path).toContain('/api/vote/');
    expect(
      (await participant.request.get(`/api/rooms/${roomId}/links`)).status(),
    ).toBe(401);
    await alice.getByRole('button', {name: 'Изменить имя: Alice'}).click();
    await page
      .getByLabel('Имя респондента', {exact: true})
      .fill('Alice renamed');
    await page.getByRole('button', {name: 'Сохранить имя'}).click();
    const renamed = page.getByRole('listitem', {
      name: 'Alice renamed',
      exact: true,
    });
    await expect(renamed).toBeVisible();
    await participant.reload();
    await expect(
      participant.getByText('Alice renamed · Персональная ссылка', {
        exact: true,
      }),
    ).toBeVisible();
    await renamed
      .getByRole('button', {name: 'Отозвать ссылку: Alice renamed'})
      .click();
    await page
      .getByRole('dialog')
      .getByRole('button', {name: 'Отозвать', exact: true})
      .click();
    await expect(renamed.getByText('Отозвана', {exact: true})).toBeVisible();
    await participant.reload();
    await expect(
      participant.getByRole('heading', {name: 'Ссылка недействительна'}),
    ).toBeVisible();
    await participant.goto(first);
    await expect(
      participant.getByRole('heading', {name: 'Ссылка недействительна'}),
    ).toBeVisible();
    await renamed
      .getByRole('button', {name: 'Перевыпустить ссылку: Alice renamed'})
      .click();
    await page
      .getByRole('dialog')
      .getByRole('button', {name: 'Перевыпустить', exact: true})
      .click();
    await expect(renamed.getByText('Действует', {exact: true})).toBeVisible();
    await renamed
      .getByRole('button', {name: 'Скопировать ссылку', exact: true})
      .click();
    await expect.poll(() => copied(page)).not.toBe(first);
    const second = await copied(page);
    expect(new URL(second).pathname).toBe(new URL(first).pathname);
    await participant.goto(second);
    await expect(
      participant.getByRole('heading', {name: 'Ожидание вопросов'}),
    ).toBeVisible();
    await expect(participant.getByRole('tab')).toHaveCount(0);
    await expect(
      participant.getByRole('button', {name: /Скопировать|Настройки/}),
    ).toHaveCount(0);
    expect(await participant.evaluate(() => document.cookie)).not.toContain(
      session.value,
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath('respondents.png'),
      fullPage: true,
    });
  } finally {
    await device.close();
  }
});

test('batch links, full copy, safe CSV, paging and list retry', async ({
  page,
}) => {
  const room = await setup(page);
  await clipboard(page);
  await page
    .getByRole('button', {name: 'Добавить респондентов', exact: true})
    .click();
  await page.getByRole('button', {name: 'Списком', exact: true}).click();
  await page.getByLabel('Режим ссылки', {exact: true}).selectOption('reusable');
  await page
    .getByLabel('Имена, по одному на строку', {exact: true})
    .fill('=SUM(1,2)\nBob\nCarol');
  await page.getByRole('button', {name: 'Создать ссылки', exact: true}).click();
  await expect(page.getByRole('listitem')).toHaveCount(3);
  await page
    .getByRole('button', {name: 'Скопировать список', exact: true})
    .click();
  await expect.poll(() => copied(page)).toContain('Bob\t');
  expect((await copied(page)).split('\n')).toHaveLength(3);
  const download = page.waitForEvent('download');
  await page.getByRole('button', {name: 'Скачать CSV', exact: true}).click();
  const file = await download;
  const csv = await readFile((await file.path())!, 'utf8');
  expect(csv).toContain('"\'=SUM(1,2)"');
  expect(csv).toContain('"Многоразовая"');
  // Use real writes to cover more than one page without slow repeated forms
  const response = await page.request.post(`/api/rooms/${room}/links`, {
    headers: {Origin: new URL(page.url()).origin},
    data: {
      mode: 'personal',
      names: Array.from({length: 51}, (_, index) => `Page ${index}`),
    },
  });
  expect(response.status()).toBe(201);
  await page.getByRole('button', {name: 'Обновить', exact: true}).click();
  await expect(page.getByRole('listitem')).toHaveCount(50);
  await page.getByRole('button', {name: 'Далее', exact: true}).click();
  await expect(page.getByRole('listitem')).toHaveCount(4);
  await page.getByRole('button', {name: 'Назад', exact: true}).click();
  await expect(page.getByRole('listitem')).toHaveCount(50);
  await page.route(
    `**/api/rooms/${room}/links?after=*`,
    (route) => route.fulfill({status: 503, body: '{}'}),
    {times: 1},
  );
  await page.getByRole('button', {name: 'Обновить', exact: true}).click();
  await expect(
    page.getByRole('alert').filter({hasText: 'Не удалось загрузить список'}),
  ).toContainText('Не удалось загрузить список');
  await page
    .getByRole('button', {name: 'Попробовать снова', exact: true})
    .click();
  await expect(page.getByRole('listitem')).toHaveCount(50);
  await page
    .getByRole('button', {name: 'Скопировать список', exact: true})
    .click();
  await expect
    .poll(async () => (await copied(page)).split('\n').length)
    .toBe(54);
});

test('participant link from the home form opens directly without saving an admin room', async ({
  page,
  browser,
}) => {
  const room = await setup(page);
  const created = await page.request.post(`/api/rooms/${room}/links`, {
    headers: {Origin: new URL(page.url()).origin},
    data: {mode: 'personal', names: ['Guest']},
  });
  const id = (await created.json()).links[0].id;
  const token = (
    await (
      await page.request.get(`/api/rooms/${room}/links/${id}/secret`)
    ).json()
  ).token;
  const link = `${new URL(page.url()).origin}/vote/${id}#key=${token}`;
  const device = await browser.newContext();
  try {
    const guest = await device.newPage();
    await guest.goto(new URL(page.url()).origin);
    await guest.getByRole('button', {name: 'Войти', exact: true}).click();
    await guest.getByLabel('Ссылка на комнату', {exact: true}).fill(link);
    await guest
      .getByRole('button', {name: 'Войти в комнату', exact: true})
      .click();
    await expect(
      guest.getByRole('heading', {name: 'Ожидание вопросов'}),
    ).toBeVisible();
    expect(
      (await device.cookies()).some((cookie) =>
        cookie.name.startsWith('vm_room_'),
      ),
    ).toBe(false);
    expect(new URL(guest.url()).hash).toBe('');
  } finally {
    await device.close();
  }
});
