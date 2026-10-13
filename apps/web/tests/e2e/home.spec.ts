import {expect, test} from '@playwright/test';

test('real API and database answer in browser', async ({page}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', {name: 'Hello world'})).toBeVisible();
  await expect(page.getByText('Соединение работает')).toBeVisible();
  await page.getByRole('button', {name: 'Проверить снова'}).click();
  await expect(page.getByRole('heading', {name: 'Hello world'})).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test('failure can be retried', async ({page}) => {
  await page.route('**/api/hello', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: '{"error":"Unavailable"}',
    }),
  );
  await page.goto('/');
  await expect(page.getByText('Не удалось получить ответ')).toBeVisible();
  await page.unroute('**/api/hello');
  await page.getByRole('button', {name: 'Проверить снова'}).click();
  await expect(page.getByRole('heading', {name: 'Hello world'})).toBeVisible();
});
