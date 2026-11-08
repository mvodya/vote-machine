import {expect, test} from '@playwright/test';
import {votingFixture} from './voting-helpers';

test('respondent QR opens in a modal and as a private standalone PNG', async ({
  page,
  context,
}, info) => {
  const f = await votingFixture(page);
  await page.goto(`/rooms/${f.room.id}`);
  await page.getByRole('tab', {name: 'Респонденты', exact: true}).click();
  const opener = page.getByRole('button', {
    name: 'QR Code: Alice',
    exact: true,
  });
  await opener.click();
  const dialog = page.getByRole('dialog', {name: 'QR Code', exact: true});
  const image = dialog.getByRole('img', {
    name: 'QR код ссылки: Alice',
    exact: true,
  });
  await expect(image).toBeVisible();
  expect(
    await image.evaluate((node: HTMLImageElement) => node.naturalWidth),
  ).toBe(768);
  expect(await image.getAttribute('src')).not.toContain('#key=');
  await page.screenshot({path: info.outputPath('link-qr.png')});
  await dialog.getByRole('button', {name: 'Закрыть', exact: true}).focus();
  await page.keyboard.press('Shift+Tab');
  await expect(
    dialog.getByRole('button', {name: 'Открыть QR код отдельно', exact: true}),
  ).toBeFocused();
  const opened = context.waitForEvent('page');
  await dialog
    .getByRole('button', {name: 'Открыть QR код отдельно', exact: true})
    .click();
  const png = await opened;
  await png.waitForLoadState();
  expect(png.url()).toContain(`/links/${f.link.id}/qr`);
  expect(png.url()).not.toContain('#key=');
  await expect(png.locator('img')).toBeVisible();
  await png.close();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test('shared-link history is off by default and changes live through respondent editing', async ({
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
  expect(link.allowRunHistory).toBe(false);
  const {token} = await (
    await page.request.get(`/api/rooms/${f.room.id}/links/${link.id}/secret`)
  ).json();
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
  const device = await browser.newContext({viewport: page.viewportSize()!});
  try {
    const participant = await device.newPage();
    await participant.goto(`${f.origin}/vote/${link.id}#key=${token}`);
    await expect(
      participant.getByRole('radio', {name: 'Yes', exact: true}),
    ).toBeVisible();
    const before = await (
      await participant.request.get(`/api/vote/${link.id}/questions`)
    ).json();
    const first = before.run.id;
    await participant.getByRole('radio', {name: 'Yes', exact: true}).check();
    await participant
      .getByRole('button', {name: 'Отправить ответ', exact: true})
      .click();
    await participant
      .getByRole('button', {name: 'Ответить еще раз', exact: true})
      .click();
    await expect(
      participant.getByRole('radio', {name: 'Yes', exact: true}),
    ).not.toBeChecked();
    await participant
      .getByRole('tab', {name: 'Список вопросов', exact: true})
      .click();
    await expect(
      participant.getByLabel('Прохождение', {exact: true}),
    ).toHaveCount(0);
    expect(
      (
        await participant.request.get(
          `/api/vote/${link.id}/questions?run=${first}`,
        )
      ).status(),
    ).toBe(404);
    await page.goto(`/rooms/${f.room.id}`);
    await page.getByRole('tab', {name: 'Респонденты', exact: true}).click();
    const row = page.getByRole('listitem', {name: 'Shared', exact: true});
    await row
      .getByRole('button', {name: 'Изменить имя: Shared', exact: true})
      .click();
    const setting = row.getByRole('checkbox', {
      name: 'Разрешить просмотр прошлых прохождений',
      exact: true,
    });
    await expect(setting).not.toBeChecked();
    await setting.check();
    await row.getByRole('button', {name: 'Сохранить', exact: true}).click();
    const runs = participant.getByLabel('Прохождение', {exact: true});
    await expect(runs).toBeVisible();
    await runs.selectOption(first);
    await expect(runs).toHaveValue(first);
    await row
      .getByRole('button', {name: 'Изменить имя: Shared', exact: true})
      .click();
    await row
      .getByRole('checkbox', {
        name: 'Разрешить просмотр прошлых прохождений',
        exact: true,
      })
      .uncheck();
    await row.getByRole('button', {name: 'Сохранить', exact: true}).click();
    await expect(runs).toHaveCount(0);
    await expect(
      participant.getByText('Без ответа', {exact: true}),
    ).toBeVisible();
    expect(
      (
        await participant.request.get(
          `/api/vote/${link.id}/answers/${f.question.id}?run=${first}`,
        )
      ).status(),
    ).toBe(404);
    await expect(
      participant.getByText('Не удалось обновить вопросы, пробуем снова', {
        exact: true,
      }),
    ).toHaveCount(0);
  } finally {
    await device.close();
  }
});

test('new reusable links expose an unchecked history option and save it for one or a batch', async ({
  page,
}) => {
  const f = await votingFixture(page);
  await page.goto(`/rooms/${f.room.id}`);
  await page.getByRole('tab', {name: 'Респонденты', exact: true}).click();
  await page
    .getByRole('button', {name: 'Добавить респондентов', exact: true})
    .click();
  const history = page.getByLabel('Разрешить просмотр прошлых прохождений', {
    exact: true,
  });
  await expect(history).toHaveCount(0);
  await page.getByLabel('Режим ссылки', {exact: true}).selectOption('reusable');
  await expect(history).not.toBeChecked();
  await history.check();
  await page.getByLabel('Имя группы', {exact: true}).fill('Shared history');
  await page.getByRole('button', {name: 'Создать ссылки', exact: true}).click();
  await expect(
    page.getByRole('heading', {name: 'Shared history', exact: true}),
  ).toBeVisible();
  let links = (
    await (await page.request.get(`/api/rooms/${f.room.id}/links`)).json()
  ).links;
  expect(
    links.find((link: {name: string}) => link.name === 'Shared history')
      .allowRunHistory,
  ).toBe(true);
  await page
    .getByRole('button', {name: 'Добавить респондентов', exact: true})
    .click();
  await expect(history).not.toBeChecked();
  await page.getByRole('button', {name: 'Списком', exact: true}).click();
  await page
    .getByLabel('Имена, по одному на строку', {exact: true})
    .fill('Default one\nDefault two');
  await page.getByRole('button', {name: 'Создать ссылки', exact: true}).click();
  await expect(
    page.getByRole('heading', {name: 'Default two', exact: true}),
  ).toBeVisible();
  links = (
    await (await page.request.get(`/api/rooms/${f.room.id}/links`)).json()
  ).links;
  expect(
    links
      .filter((link: {name: string}) => link.name.startsWith('Default'))
      .every((link: {allowRunHistory: boolean}) => !link.allowRunHistory),
  ).toBe(true);
});
