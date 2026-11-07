import {expect, test} from '@playwright/test';
import {votingFixture} from './voting-helpers';

// Sample every frame while a full option is released through a delayed reply
test('allocation release keeps its option node, checkmark and layout stable', async ({
  page,
}) => {
  const f = await votingFixture(page, {
    questionType: 'allocation',
    allowAnswerChange: true,
    choices: [
      {content: 'Slot A', capacity: 1},
      {content: 'Slot B', capacity: 1},
    ],
  });
  await page.goto(f.url);
  const slot = page.getByRole('checkbox', {name: 'Slot A', exact: true});
  await slot.check();
  await expect(
    page.getByRole('status', {name: 'Сохраняем…', exact: true}),
  ).toHaveCount(0);
  await expect(page.getByText('Свободно мест: 0', {exact: true})).toBeVisible();
  await page.route(
    `**/api/vote/${f.link.id}/answers/${f.question.id}`,
    async (route) => {
      const response = await route.fetch();
      await new Promise((resolve) => setTimeout(resolve, 250));
      await route.fulfill({response});
    },
  );
  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="Slot A"]',
    )!;
    const row = input.closest('fieldset > div')!;
    const field = input.closest('fieldset')!;
    const other = document.querySelector<HTMLInputElement>(
      'input[aria-label="Slot B"]',
    )!.parentElement!;
    const state = {
      active: true,
      frames: [] as {
        connected: boolean;
        checked: boolean;
        y: number;
        height: number;
        opacity: string;
      }[],
    };
    (window as unknown as {allocationFrames: typeof state}).allocationFrames =
      state;
    function sample() {
      if (!state.active) return;
      state.frames.push({
        connected: row.isConnected,
        checked: input.checked,
        y: field.getBoundingClientRect().y,
        height: field.getBoundingClientRect().height,
        opacity: getComputedStyle(other).opacity,
      });
      requestAnimationFrame(sample);
    }
    sample();
  });
  const refreshed = page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' &&
      new URL(response.url()).pathname === `/api/vote/${f.link.id}/questions`,
  );
  await slot.uncheck();
  await refreshed;
  await expect(
    page.getByRole('status', {name: 'Сохраняем…', exact: true}),
  ).toHaveCount(0);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const frames = await page.evaluate(() => {
    const state = (
      window as unknown as {
        allocationFrames: {
          active: boolean;
          frames: {
            connected: boolean;
            checked: boolean;
            y: number;
            height: number;
            opacity: string;
          }[];
        };
      }
    ).allocationFrames;
    state.active = false;
    return state.frames;
  });
  expect(frames.length).toBeGreaterThan(5);
  expect(
    frames.every((frame) => frame.connected && frame.opacity === '1'),
  ).toBe(true);
  expect(
    Math.max(...frames.map((frame) => frame.y)) -
      Math.min(...frames.map((frame) => frame.y)),
  ).toBeLessThan(1);
  expect(
    Math.max(...frames.map((frame) => frame.height)) -
      Math.min(...frames.map((frame) => frame.height)),
  ).toBeLessThan(1);
  expect(
    frames
      .slice(1)
      .filter((frame, index) => frame.checked !== frames[index].checked),
  ).toHaveLength(1);
  await expect(slot).toBeVisible();
  await expect(slot).not.toBeChecked();
});

// A room owner can show full options without making them selectable
test('allocation visibility is saved in settings and full options stay disabled', async ({
  page,
}) => {
  const f = await votingFixture(page, {
    questionType: 'allocation',
    hideUnavailable: false,
    choices: [
      {content: 'Slot A', capacity: 1},
      {content: 'Slot B', capacity: 1},
    ],
  });
  const booked = await page.request.post(
    `/api/rooms/${f.room.id}/questions/${f.question.id}/manual`,
    {
      headers: {Origin: f.origin},
      data: {
        requestId: crypto.randomUUID(),
        questionRevision: f.question.revision,
        ballotRevision: '0',
        choices: [f.question.choices[0].id],
      },
    },
  );
  expect(booked.status()).toBe(200);
  await page.goto(f.url);
  await expect(
    page.getByRole('checkbox', {name: 'Slot A', exact: true}),
  ).toBeVisible();
  await expect(
    page.getByRole('checkbox', {name: 'Slot A', exact: true}),
  ).toBeDisabled();
  await page.goto(`/rooms/${f.room.id}`);
  const row = page.getByRole('listitem', {
    name: 'Choose a result',
    exact: true,
  });
  await expect(row.locator('time')).toHaveCount(0);
  await expect(
    row.getByText('Бронирование вариантов', {exact: true}).locator('svg'),
  ).toHaveCount(1);
  await page.getByRole('button', {name: 'Просмотреть', exact: true}).click();
  const kind = page.getByText('Бронирование вариантов', {exact: true});
  const at = page.locator('time');
  await expect(kind.locator('svg')).toHaveCount(1);
  expect((await at.boundingBox())!.x).toBeGreaterThan(
    (await kind.boundingBox())!.x,
  );
  await page
    .getByRole('tablist', {name: 'Разделы вопроса'})
    .getByRole('tab', {name: 'Настройки', exact: true})
    .click();
  const toggle = page.getByLabel('Скрывать недоступные варианты', {
    exact: true,
  });
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await page
    .getByRole('button', {name: 'Сохранить изменения', exact: true})
    .click();
  await expect(
    page.getByText('Изменения сохранены', {exact: true}),
  ).toBeVisible();
  await page.goto(f.url);
  await expect(
    page.getByRole('checkbox', {name: 'Slot B', exact: true}),
  ).toBeVisible();
  await expect(
    page.getByRole('checkbox', {name: 'Slot A', exact: true}),
  ).toHaveCount(0);
});

// Type menus share icons and work without a pointer
test('question type menu supports the keyboard and creation fixes the type', async ({
  page,
}) => {
  const f = await votingFixture(page);
  await page.goto(`/rooms/${f.room.id}`);
  const create = page.getByRole('button', {
    name: 'Создать вопрос',
    exact: true,
  });
  await create.focus();
  await create.press('ArrowDown');
  const ordinary = page.getByRole('menuitem', {
    name: 'Выбор варианта',
    exact: true,
  });
  const allocation = page.getByRole('menuitem', {
    name: 'Бронирование вариантов',
    exact: true,
  });
  await expect(ordinary).toBeFocused();
  await expect(ordinary.locator('svg')).toHaveCount(1);
  await expect(allocation.locator('svg')).toHaveCount(1);
  await ordinary.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(create).toBeFocused();
  await create.press('ArrowDown');
  await ordinary.press('ArrowDown');
  await expect(allocation).toBeFocused();
  await allocation.press('Enter');
  await expect(
    page.getByText('Бронирование вариантов', {exact: true}),
  ).toBeVisible();
  await expect(page.getByLabel('Тип вопроса', {exact: true})).toHaveCount(0);
  await page
    .getByRole('tablist', {name: 'Разделы вопроса'})
    .getByRole('tab', {name: 'Настройки', exact: true})
    .click();
  await expect(
    page.getByLabel('Скрывать недоступные варианты', {exact: true}),
  ).toBeChecked();
});
