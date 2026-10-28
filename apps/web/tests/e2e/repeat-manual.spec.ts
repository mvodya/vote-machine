import {expect, test} from '@playwright/test';
import {votingFixture} from './voting-helpers';

// Separate browsers share a link without sharing their vote rights
test('a shared link starts automatically and repeat voting follows the room setting', async ({
  page,
  browser,
}) => {
  const f = await votingFixture(page);
  const response = await page.request.post(`/api/rooms/${f.room.id}/links`, {
    headers: {Origin: f.origin},
    data: {mode: 'reusable', names: ['Shared']},
  });
  const {
    links: [link],
  } = await response.json();
  const {token} = await (
    await page.request.get(`/api/rooms/${f.room.id}/links/${link.id}/secret`)
  ).json();
  // This scenario checks the optional history picker
  expect(
    (
      await page.request.patch(`/api/rooms/${f.room.id}/links/${link.id}`, {
        headers: {Origin: f.origin},
        data: {action: 'rename', name: link.name, allowRunHistory: true},
      })
    ).status(),
  ).toBe(200);
  const devices = await Promise.all([
    browser.newContext(),
    browser.newContext(),
  ]);
  try {
    const participants = await Promise.all(
      devices.map((device) => device.newPage()),
    );
    for (const participant of participants) {
      await participant.goto(`${f.origin}/vote/${link.id}#key=${token}`);
      await participant.getByRole('radio', {name: 'Yes', exact: true}).check();
      await participant
        .getByRole('button', {name: 'Отправить ответ', exact: true})
        .click();
      await expect(
        participant.getByRole('heading', {name: 'Все вопросы пройдены'}),
      ).toBeVisible();
      await expect(
        participant.getByRole('button', {name: 'Ответить еще раз'}),
      ).toHaveCount(0);
    }
    const participant = participants[0];
    await participant.reload();
    await expect(
      participant.getByRole('heading', {name: 'Все вопросы пройдены'}),
    ).toBeVisible();
    const {policy} = await (
      await page.request.get(`/api/rooms/${f.room.id}/reuse-policy`)
    ).json();
    expect(
      (
        await page.request.patch(`/api/rooms/${f.room.id}/reuse-policy`, {
          headers: {Origin: f.origin},
          data: {enabled: true, revision: policy.revision},
        })
      ).status(),
    ).toBe(200);
    await participant.getByRole('button', {name: 'Ответить еще раз'}).click();
    await participant.getByRole('radio', {name: 'No', exact: true}).check();
    await participant
      .getByRole('button', {name: 'Отправить ответ', exact: true})
      .click();
    await expect(
      participant.getByRole('heading', {name: 'Все вопросы пройдены'}),
    ).toBeVisible();
    await participant
      .getByRole('tab', {name: 'Список вопросов', exact: true})
      .click();
    await expect(
      participant.getByLabel('Прохождение', {exact: true}),
    ).toBeVisible();
  } finally {
    await Promise.all(devices.map((device) => device.close()));
  }
});

test('manual entry consumes a personal right and reset removes answers immediately', async ({
  page,
  browser,
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
  await expect(page.getByLabel('Состояние вопроса', {exact: true})).toHaveCount(
    0,
  );
  await page
    .getByRole('tablist', {name: 'Разделы вопроса'})
    .getByRole('tab', {name: 'Управление', exact: true})
    .click();
  await expect(
    page.getByRole('button', {name: 'Закрыть вопрос', exact: true}),
  ).toHaveCount(1);
  await page
    .getByRole('button', {name: 'Ввести голос вручную', exact: true})
    .click();
  const manual = page.getByRole('region', {
    name: 'Ручное голосование',
    exact: true,
  });
  await manual
    .getByLabel('Источник голоса', {exact: true})
    .selectOption(f.link.id);
  await manual.getByRole('radio', {name: 'Yes', exact: true}).check();
  await manual
    .getByRole('button', {name: 'Отправить ответ', exact: true})
    .click();
  await expect(manual.getByText('Голос сохранен', {exact: true})).toBeVisible();
  const device = await browser.newContext();
  try {
    const participant = await device.newPage();
    await participant.goto(f.url);
    await expect(
      participant.getByRole('heading', {name: 'Все вопросы пройдены'}),
    ).toBeVisible();
    await page
      .getByRole('button', {name: 'Сделать черновиком', exact: true})
      .click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Все ответы будут удалены');
    await dialog
      .getByRole('button', {name: 'Сделать черновиком', exact: true})
      .click();
    await expect(
      page.getByRole('button', {name: 'Открыть вопрос', exact: true}),
    ).toBeVisible();
    await participant
      .getByRole('tab', {name: 'Список вопросов', exact: true})
      .click();
    await expect(
      participant.getByRole('button', {name: 'Choose a result', exact: true}),
    ).toHaveCount(0);
  } finally {
    await device.close();
  }
});
