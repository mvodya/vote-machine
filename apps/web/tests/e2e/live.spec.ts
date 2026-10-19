import {expect, test} from '@playwright/test';
import {votingFixture} from './voting-helpers';

test('live room snapshots survive network loss without clearing an unsaved editor', async ({
  page,
}) => {
  const f = await votingFixture(page);
  await page.goto(`/rooms/${f.room.id}`);
  await page
    .getByRole('listitem', {name: 'Choose a result', exact: true})
    .getByRole('button', {name: 'Просмотреть', exact: true})
    .click();
  await page
    .getByRole('tablist', {name: 'Разделы вопроса'})
    .getByRole('tab', {name: 'Настройки', exact: true})
    .click();
  await page
    .getByLabel('Публиковать результаты участникам', {exact: true})
    .check();
  await page.request.patch(`/api/rooms/${f.room.id}`, {
    headers: {Origin: f.origin},
    data: {name: 'Live room update'},
  });
  await expect(
    page.getByRole('heading', {name: 'Live room update', exact: true}),
  ).toBeVisible({timeout: 10000});
  await expect(
    page.getByLabel('Публиковать результаты участникам', {exact: true}),
  ).toBeChecked();
  await expect(
    page.getByRole('button', {name: 'Сохранить изменения', exact: true}),
  ).toBeVisible();
  await page.context().setOffline(true);
  await expect(
    page.getByRole('button', {name: 'Сохранить изменения', exact: true}),
  ).toBeVisible();
  await page.context().setOffline(false);
  await page.request.patch(`/api/rooms/${f.room.id}`, {
    headers: {Origin: f.origin},
    data: {name: 'After reconnect'},
  });
  await expect(
    page.getByRole('heading', {name: 'After reconnect', exact: true}),
  ).toBeVisible({timeout: 15000});
  await expect(
    page.getByLabel('Публиковать результаты участникам', {exact: true}),
  ).toBeChecked();
});
