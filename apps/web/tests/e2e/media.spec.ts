import {readFile} from 'node:fs/promises';
import {expect, test, type Page} from '@playwright/test';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWMwTptpnDaTAUIBAB/uBMm6iK1UAAAAAElFTkSuQmCC',
  'base64',
);
// Use real room and media routes, never a mocked storage response
async function setup(page: Page) {
  await page.goto('/');
  await page
    .getByLabel('Название комнаты', {exact: true})
    .fill('Media browser');
  await page
    .getByRole('button', {name: 'Создать комнату', exact: true})
    .click();
  await expect(
    page.getByRole('heading', {name: 'Media browser', exact: true}),
  ).toBeVisible();
  const room = new URL(page.url()).pathname.split('/').at(-1)!;
  await page.getByRole('button', {name: 'Создать вопрос', exact: true}).click();
  return room;
}
// Open the matching preview instead of another option's editor controls
async function preview(page: Page, label: string) {
  await page
    .getByRole('group', {name: `Режим редактора: ${label}`, exact: true})
    .getByRole('button', {name: 'Предпросмотр', exact: true})
    .click();
  return page.getByRole('region', {
    name: `Предпросмотр: ${label}`,
    exact: true,
  });
}

test('image-only questions and choices upload privately, preview and survive reload', async ({
  page,
  browser,
}, info) => {
  const room = await setup(page);
  for (const label of ['Текст вопроса', 'Вариант 1', 'Вариант 2']) {
    await page
      .getByLabel(`Файл для ${label}`, {exact: true})
      .setInputFiles({name: 'pixel.png', mimeType: 'image/png', buffer: png});
    await expect(page.getByLabel(label, {exact: true})).toHaveValue(
      /^!\[Изображение\]\(asset:[0-9a-f-]+\)$/,
    );
    const panel = await preview(page, label);
    const image = panel.getByRole('img', {name: 'Изображение', exact: true});
    await expect(image).toBeVisible();
    await expect
      .poll(() =>
        image.evaluate((element) => (element as HTMLImageElement).naturalWidth),
      )
      .toBeGreaterThan(0);
  }
  const save = page.getByRole('button', {
    name: 'Сохранить черновик',
    exact: true,
  });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByText('Вопрос сохранен', {exact: true})).toBeVisible();
  const source = await page
    .getByLabel('Текст вопроса', {exact: true})
    .inputValue();
  const id = /asset:([0-9a-f-]+)/.exec(source)![1];
  const visitor = await browser.newContext();
  try {
    const response = await visitor.request.get(
      `${new URL(page.url()).origin}/api/rooms/${room}/assets/${id}`,
    );
    expect(response.status()).toBe(401);
  } finally {
    await visitor.close();
  }
  await page.getByRole('button', {name: 'К списку', exact: true}).click();
  await expect(
    page.getByRole('listitem', {name: 'Изображение', exact: true}),
  ).toBeVisible();
  await page.reload();
  await page
    .getByRole('listitem', {name: 'Изображение', exact: true})
    .getByRole('button', {name: 'Редактировать', exact: true})
    .click();
  const panel = await preview(page, 'Текст вопроса');
  await expect(panel.getByRole('img')).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath('markdown-media.png'),
    fullPage: true,
  });
});

test('uploaded WebM appears as a private video player with working byte ranges', async ({
  page,
}) => {
  const room = await setup(page);
  const clip = await readFile(
    new URL('../fixtures/clip.webm', import.meta.url),
  );
  await page
    .getByLabel('Файл для Текст вопроса', {exact: true})
    .setInputFiles({name: 'clip.webm', mimeType: 'video/webm', buffer: clip});
  await expect(page.getByLabel('Текст вопроса', {exact: true})).toHaveValue(
    /^!\[Видео\]\(asset:[0-9a-f-]+\)$/,
  );
  const source = await page
    .getByLabel('Текст вопроса', {exact: true})
    .inputValue();
  const id = /asset:([0-9a-f-]+)/.exec(source)![1];
  const panel = await preview(page, 'Текст вопроса');
  const video = panel.locator('video');
  await expect(video).toHaveAttribute('controls', '');
  await expect
    .poll(() =>
      video.evaluate((element) => (element as HTMLVideoElement).readyState),
    )
    .toBeGreaterThanOrEqual(1);
  const response = await page.request.get(`/api/rooms/${room}/assets/${id}`, {
    headers: {Range: 'bytes=0-15'},
  });
  expect(response.status()).toBe(206);
  expect((await response.body()).length).toBe(16);
  expect(response.headers()['content-type']).toBe('video/webm');
});

test('preview ignores raw HTML and remote media without sending network requests', async ({
  page,
}) => {
  await setup(page);
  const remote: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('evil.test')) remote.push(request.url());
  });
  await page
    .getByLabel('Текст вопроса', {exact: true})
    .fill(
      '# Safe heading\n\n**Bold**\n\n<script>window.markdownExecuted=true</script>\n\n<img src="https://evil.test/track" onerror="window.markdownExecuted=true">\n\n![Remote](https://evil.test/remote.png)\n\n[Bad](javascript:alert(1))',
    );
  const panel = await preview(page, 'Текст вопроса');
  await expect(
    panel.getByRole('heading', {name: 'Safe heading'}),
  ).toBeVisible();
  await expect(panel.locator('strong')).toHaveText('Bold');
  await expect(panel.locator('img,iframe,script')).toHaveCount(0);
  await expect(panel.getByRole('link', {name: 'Bad', exact: true})).toHaveCount(
    0,
  );
  expect(remote).toEqual([]);
  expect(
    await page.evaluate(() => Reflect.get(window, 'markdownExecuted')),
  ).toBeUndefined();
});
