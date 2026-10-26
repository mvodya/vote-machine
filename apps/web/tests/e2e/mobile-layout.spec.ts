import {readFile} from 'node:fs/promises';
import sharp from 'sharp';
import {expect, test} from '@playwright/test';
import {votingFixture} from './voting-helpers';

test.use({isMobile: true, hasTouch: true});

test('participant media stays inside its block on narrow and landscape screens', async ({
  page,
}, info) => {
  const fixture = await votingFixture(page);
  const path = `/api/rooms/${fixture.room.id}`;
  const headers = {Origin: fixture.origin};
  // Close the helper question so the new media question is current
  const closed = await page.request.post(
    `${path}/questions/${fixture.question.id}/lifecycle`,
    {
      headers,
      data: {action: 'close', revision: fixture.question.revision},
    },
  );
  expect(closed.status()).toBe(200);
  const sources = [];
  for (const [width, height] of [
    [1600, 400],
    [250, 1400],
  ]) {
    const buffer = await sharp({
      create: {width, height, channels: 3, background: '#a13d68'},
    })
      .png()
      .toBuffer();
    const upload = await page.request.post(`${path}/assets`, {
      headers,
      multipart: {file: {name: 'mobile.png', mimeType: 'image/png', buffer}},
    });
    expect(upload.status()).toBe(201);
    sources.push((await upload.json()).source as string);
  }
  const upload = await page.request.post(`${path}/assets`, {
    headers,
    multipart: {
      file: {
        name: 'mobile.webm',
        mimeType: 'video/webm',
        buffer: await readFile(
          new URL('../fixtures/clip.webm', import.meta.url),
        ),
      },
    },
  });
  expect(upload.status()).toBe(201);
  const video = (await upload.json()).source;
  const created = await page.request.post(`${path}/questions`, {
    headers,
    data: {
      content: `# Mobile media\n\n![Wide](${sources[0]} "width=4096")\n\n> ![Nested](${sources[0]})`,
      choiceMode: 'single',
      minChoices: 1,
      maxChoices: 1,
      shareResults: false,
      publication: 'after_close',
      hideResultsUntilEnd: false,
      allowAnswerChange: false,
      anonymous: false,
      choices: [
        {content: `![Wide choice](${sources[0]} "width=4096")`},
        {content: `![Tall choice](${sources[1]} "width=4096")`},
        {content: `![Video choice](${video} "width=4096")`},
      ],
    },
  });
  expect(created.status()).toBe(201);
  const {question} = await created.json();
  const opened = await page.request.post(
    `${path}/questions/${question.id}/lifecycle`,
    {headers, data: {action: 'open', revision: question.revision}},
  );
  expect(opened.status()).toBe(200);
  await page.goto(fixture.url);
  await expect(page.getByRole('heading', {name: 'Mobile media'})).toBeVisible();
  await expect(page.locator('main img')).toHaveCount(4);
  await expect(page.locator('main video')).toHaveCount(1);
  for (const [width, height] of [
    [320, 740],
    [390, 844],
    [844, 390],
  ]) {
    await page.setViewportSize({width, height});
    // Check the content bounds instead of hiding overflow on the page
    await expect
      .poll(() =>
        page.locator('main img, main video').evaluateAll((media) =>
          media.every((element) => {
            const box = element.getBoundingClientRect();
            const block =
              element.parentElement!.parentElement!.getBoundingClientRect();
            return (
              box.width > 0 &&
              box.left >= block.left - 1 &&
              box.right <= block.right + 1 &&
              box.left >= 0 &&
              box.right <= innerWidth
            );
          }),
        ),
      )
      .toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath(`vote-${width}.png`),
      fullPage: true,
    });
  }
});

test('home decoration crosses the form boundary and phone controls keep one scale', async ({
  page,
}, info) => {
  await page.setViewportSize({width: 1280, height: 800});
  await page.emulateMedia({reducedMotion: 'reduce'});
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({colorScheme});
    await page.goto('/');
    const canvas = page.locator('main canvas');
    await expect(canvas).toBeVisible();
    const bounds = await canvas.boundingBox();
    expect(bounds!.width).toBe(1280);
    const ribbons = page.locator('[data-ribbon]').first().locator('../..');
    expect((await ribbons.boundingBox())!.width).toBe(1280);
    const fade = await canvas
      .locator('../..')
      .evaluate((element) => getComputedStyle(element).maskImage);
    expect(fade).toContain('linear-gradient');
    await page.screenshot({
      path: info.outputPath(`home-${colorScheme}.png`),
      fullPage: true,
    });
  }
  await page.setViewportSize({width: 390, height: 844});
  const field = page.getByLabel('Название комнаты', {exact: true});
  await expect(field).toHaveCSS('font-size', '16px');
  await field.focus();
  await field.fill('Mobile input');
  const viewport = page.locator('meta[name="viewport"]');
  await expect(viewport).toHaveAttribute('content', /maximum-scale=1/);
  await expect(viewport).toHaveAttribute('content', /user-scalable=no/);
  await expect(page.locator('body')).toHaveCSS('touch-action', 'pan-x pan-y');
  expect(await page.evaluate(() => visualViewport!.scale)).toBe(1);
  await page.setViewportSize({width: 844, height: 390});
  await expect(field).toHaveCSS('font-size', '16px');
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
