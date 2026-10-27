import {expect, test, type Page} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {votingFixture} from './voting-helpers';

// The owner requested a faint noninteractive version footer
async function scan(page: Page) {
  const result = await new AxeBuilder({page})
    .exclude('footer')
    // The owner requested a fixed phone scale
    .disableRules(['meta-viewport'])
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(
    result.violations.map((item) => ({
      id: item.id,
      nodes: item.nodes.map((node) => ({
        target: node.target,
        reason: node.failureSummary,
      })),
    })),
  ).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
}

test('home, empty room, settings and errors support keyboard access in both themes', async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.emulateMedia({reducedMotion: 'reduce'});
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({colorScheme});
    await page.goto('/');
    await expect(
      page.getByRole('heading', {name: 'Новая комната', exact: true}),
    ).toBeVisible();
    await scan(page);
  }
  await page
    .getByLabel('Название комнаты', {exact: true})
    .fill('Keyboard room');
  await page
    .getByRole('button', {name: 'Создать комнату', exact: true})
    .focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('heading', {name: 'Keyboard room', exact: true}),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', {name: 'Вопросов пока нет', exact: true}),
  ).toBeVisible();
  await scan(page);
  const tabs = page.getByRole('tablist', {name: 'Разделы комнаты'});
  await tabs.getByRole('tab', {name: 'Вопросы', exact: true}).focus();
  await page.keyboard.press('End');
  const settings = tabs.getByRole('tab', {name: 'Настройки', exact: true});
  await expect(settings).toBeFocused();
  await expect(settings).toHaveAttribute('aria-selected', 'true');
  const panel = page.getByRole('tabpanel', {name: 'Настройки', exact: true});
  expect(await settings.getAttribute('aria-controls')).toBe(
    await panel.getAttribute('id'),
  );
  await page.keyboard.press('Tab');
  await expect(panel).not.toBeFocused();
  await expect(
    page.getByLabel('Название комнаты', {exact: true}),
  ).toBeFocused();
  await scan(page);
  const remove = page.getByRole('button', {
    name: 'Удалить комнату',
    exact: true,
  });
  await remove.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', {name: 'Удалить комнату?'});
  await expect(
    dialog.getByRole('button', {name: 'Отмена', exact: true}),
  ).toBeFocused();
  await scan(page);
  await dialog.getByRole('button', {name: 'Отмена', exact: true}).focus();
  await page.keyboard.press('Shift+Tab');
  await expect(
    dialog.getByRole('button', {name: 'Удалить комнату', exact: true}),
  ).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(remove).toBeFocused();
  for (const path of [
    '/rooms/not-a-room',
    '/vote/not-a-link',
    '/missing-page',
  ]) {
    await page.goto(path);
    await expect(page.getByRole('heading').first()).toBeVisible();
    await scan(page);
  }
});

test('question editing, shared timezone, answering and projector remain accessible', async ({
  page,
  browser,
}, info) => {
  test.setTimeout(120000);
  await page.emulateMedia({reducedMotion: 'reduce', colorScheme: 'light'});
  const f = await votingFixture(page, {
    shareResults: true,
    publication: 'after_answer',
    allowAnswerChange: true,
  });
  await page.goto(`/rooms/${f.room.id}`);
  await page.getByRole('button', {name: 'Создать вопрос', exact: true}).click();
  await expect(page.getByLabel('Текст вопроса', {exact: true})).toBeVisible();
  await scan(page);
  const sections = page.getByRole('tablist', {name: 'Разделы вопроса'});
  await sections
    .getByRole('tab', {name: 'Редактирование', exact: true})
    .focus();
  await page.keyboard.press('ArrowRight');
  await expect(
    sections.getByRole('tab', {name: 'Настройки', exact: true}),
  ).toBeFocused();
  await scan(page);
  await page.keyboard.press('ArrowRight');
  await expect(
    sections.getByRole('tab', {name: 'Управление', exact: true}),
  ).toBeFocused();
  await scan(page);
  const roomTabs = page.getByRole('tablist', {name: 'Разделы комнаты'});
  await roomTabs.getByRole('tab', {name: 'Настройки', exact: true}).click();
  const zone = page.getByLabel('Часовой пояс комнаты', {exact: true});
  if ((await zone.inputValue()) === 'Asia/Vladivostok') {
    await zone.selectOption('UTC');
    await expect(zone).toBeEnabled();
    await expect
      .poll(
        async () =>
          (await (await page.request.get(`/api/rooms/${f.room.id}`)).json())
            .room.timeZone,
      )
      .toBe('UTC');
  }
  await zone.selectOption('Asia/Vladivostok');
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/rooms/${f.room.id}`)).json()).room
          .timeZone,
    )
    .toBe('Asia/Vladivostok');
  const changed = await page.request.post(
    `/api/rooms/${f.room.id}/questions/${f.question.id}/lifecycle`,
    {
      headers: {Origin: f.origin},
      data: {
        action: 'settings',
        revision: f.question.revision,
        closesAt: '2026-12-10T20:30:00Z',
        shareResults: true,
        publication: 'after_answer',
      },
    },
  );
  expect(changed.status()).toBe(200);
  const context = await browser.newContext({
    viewport: page.viewportSize()!,
    timezoneId: 'America/New_York',
    reducedMotion: 'reduce',
  });
  try {
    const guest = await context.newPage();
    await guest.goto(f.url);
    const yes = guest.getByRole('radio', {name: 'Yes', exact: true});
    await expect(yes).toBeVisible();
    await expect(
      guest.getByRole('timer', {name: 'До закрытия'}),
    ).toHaveAttribute('title', /11\.12\.2026.*06:30/);
    await scan(guest);
    await yes.focus();
    await guest.keyboard.press('Space');
    await expect(yes).toBeChecked();
    await guest
      .getByRole('button', {name: 'Отправить ответ', exact: true})
      .focus();
    await guest.keyboard.press('Enter');
    await expect(
      guest.getByRole('heading', {name: 'Все вопросы пройдены'}),
    ).toBeVisible();
    await expect(
      guest.getByRole('tabpanel', {name: 'Вопрос', exact: true}),
    ).toBeFocused();
    await scan(guest);
    const guestTabs = guest.getByRole('tablist', {name: 'Вкладки участника'});
    await guestTabs.getByRole('tab', {name: 'Вопрос', exact: true}).focus();
    await guest.keyboard.press('ArrowRight');
    await expect(
      guestTabs.getByRole('tab', {name: 'Список вопросов', exact: true}),
    ).toBeFocused();
    await scan(guest);
    await guest
      .getByRole('button', {name: 'Choose a result', exact: true})
      .click();
    await expect(
      guest.getByRole('button', {name: 'Закрыть', exact: true}),
    ).toBeVisible();
    await guest.getByRole('button', {name: 'Закрыть', exact: true}).click();
    await expect(
      guestTabs.getByRole('tab', {name: 'Список вопросов', exact: true}),
    ).toHaveAttribute('aria-selected', 'true');
    await page.goto(
      `/rooms/${f.room.id}?projector=1&question=${f.question.id}`,
    );
    await expect(
      page.getByRole('region', {name: 'Итоги вопроса'}),
    ).toBeVisible();
    await scan(page);
    await page.screenshot({
      path: info.outputPath('accessible-projector.png'),
      fullPage: true,
      animations: 'disabled',
    });
    await guest.setViewportSize({width: 320, height: 740});
    await scan(guest);
    await guest.screenshot({
      path: info.outputPath('accessible-mobile-history.png'),
      fullPage: true,
      animations: 'disabled',
    });
  } finally {
    await context.close();
  }
});
