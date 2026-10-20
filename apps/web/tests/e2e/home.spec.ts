import {expect, test} from '@playwright/test';

test('home offers room creation without an account', async ({page}) => {
  await page.goto('/');
  await expect(
    page.getByRole('heading', {name: 'Новая комната', exact: true}),
  ).toBeVisible();
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
  // Desktop keeps the split, phones show only room entry
  if (info.project.name === 'desktop') {
    await expect(story).toBeVisible();
    const left = await story.boundingBox();
    const right = await access.boundingBox();
    expect(left!.width / right!.width).toBeCloseTo(1.5, 1);
    expect(right!.x).toBeCloseTo(left!.width, 1);
  } else {
    await expect(story).toBeHidden();
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
  await page.screenshot({path: info.outputPath('home.png'), fullPage: true});
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
  expect(bounds!.width).toBeCloseTo(
    screen.width * (info.project.name === 'desktop' ? 0.6 : 1),
    0,
  );
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
