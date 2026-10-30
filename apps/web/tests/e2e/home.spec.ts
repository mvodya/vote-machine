import {expect, test} from '@playwright/test';
import {votingFixture} from './voting-helpers';

test('home offers room creation without an account', async ({page}) => {
  await page.goto('/');
  await expect(
    page.getByRole('heading', {name: 'Новая комната', exact: true}),
  ).toBeVisible();
  await expect(page.locator('main > header img')).toHaveCount(0);
  await expect(page.locator('[data-hero-brand]')).toHaveCount(1);

  await expect(
    page.getByRole('button', {name: 'Создать комнату', exact: true}),
  ).toBeEnabled();
  await expect(
    page.getByLabel('Название комнаты', {exact: true}),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test('room creation can be retried after a service failure', async ({page}) => {
  await page.route('**/api/rooms', (route) =>
    route.fulfill({status: 503, json: {error: 'Unavailable'}}),
  );
  await page.goto('/');
  await page
    .getByRole('button', {name: 'Создать комнату', exact: true})
    .click();
  await expect(
    page.getByRole('alert').filter({hasText: 'Не удалось создать комнату'}),
  ).toHaveText('Не удалось создать комнату, попробуйте снова');
  await page.unroute('**/api/rooms');
  await page
    .getByRole('button', {name: 'Создать комнату', exact: true})
    .click();
  await expect(page).toHaveURL(/\/rooms\/[0-9a-f-]+(?:#.*)?$/);
  await expect(
    page.getByRole('heading', {name: 'Новая комната', exact: true}),
  ).toBeVisible();
});

test('invalid link does not reveal room data', async ({page}) => {
  await page.goto('/rooms/not-a-room#admin=bad');
  await expect(
    page.getByRole('heading', {name: 'Нет доступа к комнате'}),
  ).toBeVisible();
  expect(new URL(page.url()).hash).toBe('');
  await expect(page.getByLabel('Название комнаты')).toHaveCount(0);
});

test('home uses the desktop split and a compact mobile entry', async ({
  page,
}, info) => {
  await page.goto('/');
  const story = page.getByRole('complementary', {name: 'О votemachine'});
  const access = page.getByRole('region', {name: 'Создание комнаты и вход'});
  // Desktop keeps the split, phones put public details below the form
  if (info.project.name === 'desktop') {
    await expect(story).toBeVisible();
    const left = await story.boundingBox();
    const right = await access.boundingBox();
    expect(left!.width / right!.width).toBeCloseTo(1.5, 1);
    expect(right!.x).toBeCloseTo(left!.width, 1);
    const caption = await page.locator('[data-home-caption]').boundingBox();
    const selector = await page
      .getByRole('group', {name: 'Действие с комнатой', exact: true})
      .boundingBox();
    const brand = await page.locator('[data-hero-brand]').boundingBox();
    expect(brand!.y).toBeCloseTo(selector!.y, 0);
    expect(caption!.y).toBeGreaterThanOrEqual(brand!.y + brand!.height);
    const details = await page
      .getByRole('link', {name: 'Подробнее о Vote Machine', exact: true})
      .boundingBox();
    expect(details!.x).toBeLessThan(right!.x);
    expect(details!.y).toBeGreaterThanOrEqual(caption!.y + caption!.height);
  } else {
    await expect(story).toBeVisible();
    const brand = await page.locator('[data-hero-brand]').boundingBox();
    expect(brand!.y + brand!.height).toBeLessThanOrEqual(
      (await access.boundingBox())!.y,
    );
    expect((await story.boundingBox())!.y).toBeGreaterThanOrEqual(
      (await access.boundingBox())!.y + (await access.boundingBox())!.height,
    );
    await expect(page.locator('main > header')).toBeVisible();
  }
  await page.getByRole('button', {name: 'Войти', exact: true}).click();
  await expect(page.getByLabel('Ссылка на комнату')).toBeVisible();
  await page
    .getByLabel('Ссылка на комнату')
    .fill('https://other.test/rooms/private');
  await page.getByRole('button', {name: 'Войти в комнату'}).click();
  await expect(
    page.getByText('Вставьте корректную ссылку на комнату с этого сайта'),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole('button', {name: 'Создать', exact: true}).click();
  await expect(
    page.getByLabel('Название комнаты', {exact: true}),
  ).toBeVisible();
  await expect(
    page.getByText('Без регистрации и пароля', {exact: false}),
  ).toHaveCount(0);
  await page.emulateMedia({reducedMotion: 'reduce'});
  await expect(page.locator('[data-home-caption]')).toHaveText(
    'Система организации голосований',
  );
  await page.screenshot({
    path: info.outputPath('home.png'),
    fullPage: true,
    animations: 'disabled',
  });
});

// Decorative motion must never block entry or ignore reduced motion
test('dot waves animate behind the layout and stop for reduced motion', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  const canvas = page.locator('main canvas');
  await expect(canvas).toBeVisible();
  await expect
    .poll(() =>
      canvas.evaluate((element) => (element as HTMLCanvasElement).width),
    )
    .toBeGreaterThan(0);
  const painted = await canvas.evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const pixels = canvas
      .getContext('2d')!
      .getImageData(0, 0, canvas.width, canvas.height).data;
    return pixels.some((value, index) => index % 4 === 3 && value > 0);
  });
  expect(painted).toBe(true);
  const snapshot = () =>
    canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL());
  const first = await snapshot();
  await expect.poll(snapshot).not.toBe(first);
  const bounds = await canvas.boundingBox();
  const screen = page.viewportSize()!;
  expect(bounds!.width).toBeCloseTo(screen.width, 0);
  await page.mouse.move(screen.width * 0.25, screen.height * 0.65);
  await page.getByLabel('Название комнаты', {exact: true}).fill('Wave room');
  await expect(page.getByLabel('Название комнаты', {exact: true})).toHaveValue(
    'Wave room',
  );
  await page.emulateMedia({reducedMotion: 'reduce'});
  // Wait for the preference listener to draw its still frame
  await page.waitForTimeout(100);
  const still = await snapshot();
  await page.mouse.move(5, 5);
  await page.waitForTimeout(150);
  expect(await snapshot()).toBe(still);
  await page
    .getByRole('button', {name: 'Переключить тему', exact: true})
    .click();
  await expect.poll(snapshot).not.toBe(still);
  await page.screenshot({
    path: info.outputPath('dot-waves.png'),
    fullPage: true,
    animations: 'disabled',
  });
  expect(errors).toEqual([]);
});

// The typing slot keeps its size while complete phrases are held and erased
test('home caption types and changes phrases without moving the form', async ({
  page,
}) => {
  await page.clock.install();
  await page.goto('/');
  const caption = page.locator('[data-home-caption]');
  const form = page.getByRole('region', {name: 'Создание комнаты и вход'});
  const before = await form.boundingBox();
  const slot = await caption.boundingBox();
  await page.clock.runFor(2800);
  await expect(caption).toHaveText('Система организации голосований');
  await page.clock.runFor(3500);
  await expect(caption).toHaveText('Система организации голосований');
  await page.clock.runFor(5000);
  await expect(caption).not.toHaveText('Система организации голосований');
  expect(await form.boundingBox()).toEqual(before);
  expect(await caption.boundingBox()).toEqual(slot);
  await page.emulateMedia({reducedMotion: 'reduce'});
  await expect(caption).toHaveText('Система организации голосований');
  await page.clock.runFor(15000);
  await expect(caption).toHaveText('Система организации голосований');
});

test('every page has a quiet footer and a real short revision', async ({
  page,
}) => {
  for (const path of [
    '/',
    '/rooms/not-a-room',
    '/vote/not-a-link',
    '/page-not-found',
  ]) {
    await page.goto(path);
    const footer = page.getByRole('contentinfo');
    await expect(footer).toHaveText(/^Vote Machine · [a-f0-9]{7}$/);
    await expect(footer).toHaveCSS('font-size', '10px');
    await expect(footer).toHaveCSS('text-align', 'right');
    await expect(footer).toHaveCSS('position', 'absolute');
    const positions = await footer.evaluate((element) => ({
      bottom: element.getBoundingClientRect().bottom,
      page: document.body.getBoundingClientRect().bottom,
      background: getComputedStyle(element).backgroundColor,
      height: document.documentElement.scrollHeight,
      mainHeight:
        document.querySelector('main')?.getBoundingClientRect().height ??
        innerHeight,
    }));
    expect(positions.page - positions.bottom).toBeCloseTo(8, 0);
    expect(positions.background).toBe('rgba(0, 0, 0, 0)');
    expect(positions.height).toBeLessThanOrEqual(
      Math.ceil(Math.max(page.viewportSize()!.height, positions.mainHeight)),
    );
  }
});

// Deletion needs confirmation and invalidates every role after success
test('room deletion confirms, retries a failed request and removes participant access', async ({
  page,
  browser,
}) => {
  const f = await votingFixture(page);
  const context = await browser.newContext();
  try {
    const guest = await context.newPage();
    await guest.goto(f.url);
    await expect(
      guest.getByRole('radio', {name: 'Yes', exact: true}),
    ).toBeVisible();
    await page.goto(`/rooms/${f.room.id}`);
    await page
      .getByRole('tablist', {name: 'Разделы комнаты'})
      .getByRole('tab', {name: 'Настройки', exact: true})
      .click();
    const remove = page.getByRole('button', {
      name: 'Удалить комнату',
      exact: true,
    });
    await remove.click();
    const dialog = page.getByRole('dialog', {name: 'Удалить комнату?'});
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', {name: 'Отмена', exact: true}).click();
    await expect(dialog).toHaveCount(0);
    await remove.click();
    await page.route(`**/api/rooms/${f.room.id}`, (route) =>
      route.request().method() === 'DELETE'
        ? route.fulfill({status: 503, json: {error: 'Unavailable'}})
        : route.continue(),
    );
    await dialog
      .getByRole('button', {name: 'Удалить комнату', exact: true})
      .click();
    await expect(dialog.getByRole('alert')).toContainText('Не удалось удалить');
    await page.unroute(`**/api/rooms/${f.room.id}`);
    await dialog
      .getByRole('button', {name: 'Удалить комнату', exact: true})
      .click();
    await expect(page).toHaveURL(f.origin + '/');
    await expect(
      guest.getByRole('heading', {name: 'Ссылка недействительна'}),
    ).toBeVisible();
    expect(
      (await page.context().cookies()).some(
        (cookie) => cookie.name === `vm_room_${f.room.id}`,
      ),
    ).toBe(false);
  } finally {
    await context.close();
  }
});
