import {expect, test, type Page} from '@playwright/test';
import {votingFixture} from './voting-helpers';

// Keep the menu easy to find before and after a language switch
async function chooseLanguage(page: Page, language: 'English' | 'Русский') {
  await page
    .getByRole('button', {name: /^(Язык интерфейса|Interface language)$/})
    .click();
  await page
    .getByRole('dialog', {name: /^(Язык интерфейса|Interface language)$/})
    .getByRole('button', {name: language, exact: true})
    .click();
  await expect(page.locator('html')).toHaveAttribute(
    'lang',
    language === 'English' ? 'en' : 'ru',
  );
}

test('language switches preserve input and persist across reloads and other tabs', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await page.getByLabel('Название комнаты', {exact: true}).fill('Настройки');
  const other = await context.newPage();
  await other.goto('/');
  await chooseLanguage(page, 'English');
  await expect(page.getByLabel('Room name', {exact: true})).toHaveValue(
    'Настройки',
  );
  await expect(
    other.getByRole('button', {name: 'Create room', exact: true}),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('button', {name: 'Create room', exact: true}),
  ).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await chooseLanguage(page, 'Русский');
  await expect(
    page.getByLabel('Название комнаты', {exact: true}),
  ).toBeVisible();
  await other.close();
});

test('the first server render uses the browser language or saved preference without JavaScript', async ({
  browser,
}) => {
  const device = await browser.newContext({
    locale: 'en-GB',
    extraHTTPHeaders: {'Accept-Language': 'en-GB'},
    javaScriptEnabled: false,
  });
  try {
    const page = await device.newPage();
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(
      page.getByRole('button', {name: 'Create room', exact: true}),
    ).toBeVisible();
    await device.addCookies([
      {name: 'vm-language', value: 'ru', url: page.url()},
    ]);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
    await expect(
      page.getByRole('button', {name: 'Создать комнату', exact: true}),
    ).toBeVisible();
  } finally {
    await device.close();
  }
});

test('room editing keeps unsaved content when labels and dialogs change language', async ({
  page,
}) => {
  const f = await votingFixture(page, {content: 'Настройки'});
  await page.goto(`/rooms/${f.room.id}`);
  await page.getByRole('button', {name: 'Создать вопрос', exact: true}).click();
  await page.getByLabel('Текст вопроса', {exact: true}).fill('Результаты');
  await chooseLanguage(page, 'English');
  await expect(page.getByLabel('Question text', {exact: true})).toHaveValue(
    'Результаты',
  );
  const tabs = page.getByRole('tablist', {
    name: 'Question sections',
    exact: true,
  });
  await tabs.getByRole('tab', {name: 'Settings', exact: true}).click();
  await expect(
    page.getByLabel('Allow skipping the question', {exact: true}),
  ).toBeVisible();
  await page.getByRole('button', {name: 'Cancel', exact: true}).click();
  const dialog = page.getByRole('dialog', {
    name: 'Discard changes?',
    exact: true,
  });
  await expect(
    dialog.getByRole('button', {name: 'Continue editing', exact: true}),
  ).toBeVisible();
  await dialog
    .getByRole('button', {name: 'Continue editing', exact: true})
    .click();
  await tabs.getByRole('tab', {name: 'Editing', exact: true}).click();
  await expect(page.getByLabel('Question text', {exact: true})).toHaveValue(
    'Результаты',
  );
  await chooseLanguage(page, 'Русский');
  await expect(page.getByLabel('Текст вопроса', {exact: true})).toHaveValue(
    'Результаты',
  );
});

test('participant voting and results translate labels without translating question content', async ({
  page,
  browser,
}) => {
  const f = await votingFixture(page, {
    content: 'Настройки',
    shareResults: true,
    publication: 'after_answer',
  });
  const device = await browser.newContext({
    locale: 'en-GB',
    extraHTTPHeaders: {'Accept-Language': 'en-GB'},
    viewport: page.viewportSize()!,
  });
  try {
    const participant = await device.newPage();
    await participant.goto(f.url);
    const question = participant.getByRole('region', {
      name: 'Current question',
      exact: true,
    });
    await expect(question.getByText('Настройки', {exact: true})).toBeVisible();
    await question.getByRole('radio', {name: 'Yes', exact: true}).check();
    await question
      .getByRole('button', {name: 'Submit response', exact: true})
      .click();
    await expect(
      participant.getByRole('heading', {
        name: 'All questions completed',
        exact: true,
      }),
    ).toBeVisible();
    await participant.getByRole('tab', {name: 'Results', exact: true}).click();
    await participant
      .getByRole('button', {name: 'Results: Настройки', exact: true})
      .click();
    await expect(
      participant
        .getByRole('region', {name: 'Question results', exact: true})
        .getByText('Responses: 1', {exact: true}),
    ).toBeVisible();
    await chooseLanguage(participant, 'Русский');
    await expect(
      participant.getByRole('button', {
        name: 'Результаты: Настройки',
        exact: true,
      }),
    ).toBeVisible();
  } finally {
    await device.close();
  }
});
