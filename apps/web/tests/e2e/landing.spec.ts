import {expect, test} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// The product page reuses real views without reading or writing room data
test('ballots work locally and only the phone is shown on small screens', async ({
  page,
}, info) => {
  await page.emulateMedia({reducedMotion: 'reduce'});
  const requests: string[] = [];
  page.on('request', (request) => {
    if (/\/api\/(rooms|vote)(\/|$)/.test(new URL(request.url()).pathname))
      requests.push(request.url());
  });
  await page.goto('/');
  await page
    .getByRole('link', {name: 'Подробнее о vote.machine.', exact: true})
    .click();
  await expect(
    page.getByRole('heading', {name: 'vote.machine.', exact: true}),
  ).toBeVisible();
  await expect(page.locator('main header img')).toHaveCount(0);
  await expect(page.locator('[data-hero-brand]')).toHaveCount(1);

  await page.screenshot({
    animations: 'disabled',
    path: info.outputPath('landing-hero.png'),
  });
  const wide = (info.project.use.viewport?.width ?? 1280) >= 768;
  const computer = page.getByRole('region', {name: 'Компьютер', exact: true});
  const phone = page.getByRole('region', {name: 'Смартфон', exact: true});
  if (wide) {
    await computer.getByRole('radio', {name: 'Онлайн', exact: true}).check();
    await expect(
      phone.getByRole('radio', {name: 'Онлайн', exact: true}),
    ).not.toBeChecked();
    await computer
      .getByRole('button', {name: 'Отправить ответ', exact: true})
      .click();
    await expect(
      computer.getByRole('button', {name: 'Изменить ответ', exact: true}),
    ).toBeVisible();
    await expect(computer.locator('header')).toHaveCount(0);
  } else {
    await expect(page.locator('[data-device="computer"]')).toBeHidden();
  }
  await phone.getByRole('radio', {name: 'Гибридный', exact: true}).check();
  await phone
    .getByRole('button', {name: 'Отправить ответ', exact: true})
    .click();
  await expect(phone.getByRole('status')).toHaveText('Ваш ответ сохранен');
  await phone.getByRole('radio', {name: 'Очно', exact: true}).check();
  await phone
    .getByRole('button', {name: 'Изменить ответ', exact: true})
    .click();
  await expect(page.locator('[data-admin-total]')).toHaveAttribute(
    'data-admin-total',
    wide ? '39' : '38',
  );
  await expect(page.locator('[data-demo-screen="results"]')).toHaveCount(0);
  await expect(phone.locator('header')).toHaveCount(0);
  await expect(page.locator('[data-demo-screen="projector"]')).toHaveAttribute(
    'data-demo-total',
    '51',
  );
  await page.locator('[data-device="phone"]').screenshot({
    animations: 'disabled',
    path: info.outputPath('landing-phone.png'),
  });
  await page.locator('[data-projector-screen]').scrollIntoViewIfNeeded();
  await page.screenshot({
    animations: 'disabled',
    path: info.outputPath('landing-projector.png'),
  });
  await expect(page.locator('[data-projector-screen]')).toContainText(
    'Какую тему разберем на следующей встрече?',
  );
  const tabs = page.getByRole('tablist', {
    name: 'Разделы комнаты',
    exact: true,
  });
  await tabs.scrollIntoViewIfNeeded();
  const window = page.locator('[data-admin-window]');
  const before = await window.boundingBox();
  await tabs.getByRole('tab', {name: 'Респонденты', exact: true}).click();
  await expect(
    page.locator('[role="tabpanel"]:not([hidden])').last(),
  ).toContainText('Добавить респондентов');
  await tabs.getByRole('tab', {name: 'Результаты', exact: true}).click();
  await expect(
    page.locator('[role="tabpanel"]:not([hidden])').last(),
  ).toContainText('Скачать XLSX');
  const after = await window.boundingBox();
  expect(Math.abs(before!.height - after!.height)).toBeLessThan(1);
  await expect(window).toHaveCSS('overflow', 'hidden');
  await page.screenshot({
    animations: 'disabled',
    path: info.outputPath('landing-admin.png'),
  });
  for (const width of [320, 2560]) {
    await page.setViewportSize({width, height: 1000});
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await page
    .getByRole('link', {name: 'vote.machine.', exact: true})
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    animations: 'disabled',
    path: info.outputPath('landing-footer.png'),
  });
  expect(requests).toEqual([]);
});

test('real controls translate and remain accessible in both themes', async ({
  page,
}) => {
  await page.emulateMedia({reducedMotion: 'reduce'});
  await page.goto('/about');
  const phone = page.getByRole('region', {name: 'Смартфон', exact: true});
  await phone.getByRole('radio', {name: 'Очно', exact: true}).check();
  await phone
    .getByRole('button', {name: 'Отправить ответ', exact: true})
    .click();
  await page
    .getByRole('button', {name: 'Язык интерфейса', exact: true})
    .click();
  await page.getByRole('button', {name: 'English', exact: true}).click();
  await expect(
    page.getByRole('heading', {
      name: 'One question Independent answers',
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page
      .getByRole('region', {name: 'Phone', exact: true})
      .getByRole('radio', {name: 'In person', exact: true}),
  ).toBeChecked();
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({colorScheme});
    await expect(page.locator('html')).toHaveAttribute(
      'data-theme',
      colorScheme,
    );
    const issues = await new AxeBuilder({page})
      .exclude('footer')
      // Fixed phone scaling is a separate owner preference
      .disableRules(['meta-viewport'])
      .analyze();
    expect(
      issues.violations.map(({id, nodes}) => ({
        id,
        nodes: nodes.map(({target, failureSummary}) => ({
          target,
          failureSummary,
        })),
      })),
    ).toEqual([]);
  }
});

test('the story scrolls smoothly and admin tabs advance on their own', async ({
  page,
}) => {
  await page.goto('/about');
  await page
    .getByRole('link', {name: 'Посмотрите, как это работает', exact: true})
    .click();
  await expect(page).toHaveURL(/#devices$/);
  await expect(
    page.getByRole('heading', {
      name: 'Один вопрос Независимые ответы',
      exact: true,
    }),
  ).toBeInViewport();
  const tabs = page.getByRole('tablist', {
    name: 'Разделы комнаты',
    exact: true,
  });
  await tabs.scrollIntoViewIfNeeded();
  await expect(
    tabs.getByRole('tab', {name: 'Респонденты', exact: true}),
  ).toHaveAttribute('aria-selected', 'true', {timeout: 9000});
  await tabs.getByRole('tab', {name: 'Вопросы', exact: true}).click();
  await expect(
    page.locator('[role="tabpanel"]:not([hidden])').last(),
  ).toContainText('Создать вопрос');
});

test('projector votes and admin viewers grow only while their screens are visible', async ({
  page,
}) => {
  await page.goto('/about');
  const projector = page.locator('[data-demo-screen="projector"]');
  await projector.scrollIntoViewIfNeeded();
  const initial = Number(await projector.getAttribute('data-demo-total'));
  await expect
    .poll(async () => Number(await projector.getAttribute('data-demo-total')), {
      timeout: 8000,
    })
    .toBeGreaterThan(initial);
  const admin = page.locator('[data-admin-total]');
  await admin.scrollIntoViewIfNeeded();
  const answers = Number(await admin.getAttribute('data-admin-total'));
  const viewers = await admin.getAttribute('data-admin-viewers');
  await expect
    .poll(async () => Number(await admin.getAttribute('data-admin-total')), {
      timeout: 8000,
    })
    .toBeGreaterThan(answers);
  await expect(admin).not.toHaveAttribute('data-admin-viewers', viewers!);
});

test('server markup hydrates cleanly and the second question repeats its minute cycle', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (/hydrat|didn't match/i.test(message.text()))
      errors.push(message.text());
  });
  await page.emulateMedia({reducedMotion: 'reduce'});
  await page.clock.install();
  await page.goto('/about');
  const question = page.locator('li[aria-label="Какие темы обсудим?"]');
  await expect(
    question.getByText('Ожидание открытия', {exact: true}),
  ).toHaveCount(1);
  await page.reload();
  await expect(
    question.getByText('Ожидание открытия', {exact: true}),
  ).toHaveCount(1);
  expect(errors).toEqual([]);
  await page.clock.fastForward(60000);
  await expect(question.getByText('Открыт', {exact: true})).toHaveCount(1);
  await expect(question.locator('[role="timer"]')).toHaveAttribute(
    'aria-label',
    'До закрытия',
  );
  await page.clock.fastForward(60000);
  await expect(
    question.getByText('Ожидание открытия', {exact: true}),
  ).toHaveCount(1);
  await expect(question.locator('[role="timer"]')).toHaveAttribute(
    'aria-label',
    'До открытия',
  );
});

test('device frames shrink together above the phone breakpoint', async ({
  page,
}) => {
  await page.emulateMedia({reducedMotion: 'reduce'});
  await page.goto('/about');
  const widths = [];
  for (const width of [1280, 1000, 800]) {
    await page.setViewportSize({width, height: 1000});
    const computer = page.locator('[data-device="computer"]');
    const phone = page.locator('[data-device="phone"]');
    await expect
      .poll(async () => {
        const a = await computer.boundingBox();
        const b = await phone.boundingBox();
        return Math.abs(a!.width / b!.width - 782 / 350);
      })
      .toBeLessThan(0.05);
    widths.push({
      computer: (await computer.boundingBox())!.width,
      phone: (await phone.boundingBox())!.width,
    });
  }
  expect(widths[2].phone).toBeLessThan(widths[0].phone * 0.8);
  expect(widths[2].computer).toBeLessThan(widths[0].computer * 0.8);
});
