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
    await expect(page.locator('.mobile-brand')).toBeVisible();
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
