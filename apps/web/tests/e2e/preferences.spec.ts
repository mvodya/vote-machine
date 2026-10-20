import {expect, test, type BrowserContext, type Page} from '@playwright/test';
import {votingFixture} from './voting-helpers';
// Record audio calls without depending on speakers on the test machine
async function recordSounds(context: BrowserContext) {
  await context.addInitScript(() => {
    const scope = window as unknown as {
      sounds: string[];
      decodedSounds: string[];
    };
    scope.sounds = [];
    scope.decodedSounds = [];
    const bytes = new WeakMap<ArrayBuffer, string>();
    const samples = new WeakMap<AudioBuffer, string>();
    const fetcher = window.fetch;
    window.fetch = async (...args) => {
      const response = await fetcher(...args);
      const url = new URL(response.url);
      if (url.pathname.startsWith('/sounds/')) {
        const read = response.arrayBuffer.bind(response);
        response.arrayBuffer = async () => {
          const data = await read();
          bytes.set(data, url.pathname);
          return data;
        };
      }
      return response;
    };
    // Keep the real decoder and output path, record only named sample starts
    const decode = AudioContext.prototype.decodeAudioData;
    AudioContext.prototype.decodeAudioData = function (data) {
      const path = bytes.get(data);
      return decode.call(this, data).then((buffer) => {
        if (path) {
          samples.set(buffer, path);
          scope.decodedSounds.push(path);
        }
        return buffer;
      });
    };
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (
      when = 0,
      offset = 0,
      duration?: number,
    ) {
      const path = this.buffer && samples.get(this.buffer);
      if (path) scope.sounds.push(path);
      if (duration === undefined) start.call(this, when, offset);
      else start.call(this, when, offset, duration);
    };
  });
}
async function sounds(page: Page) {
  return page.evaluate(() => (window as unknown as {sounds: string[]}).sounds);
}
test('system theme is correct on the first frame and a smooth override survives reload', async ({
  browser,
}) => {
  const context = await browser.newContext({colorScheme: 'dark'});
  try {
    await context.addInitScript(() => {
      const record = () => {
        if (!document.body) {
          requestAnimationFrame(record);
          return;
        }
        (window as unknown as {firstTheme: string | undefined}).firstTheme =
          document.documentElement.dataset.theme;
      };
      requestAnimationFrame(record);
    });
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    const contrast = await page
      .getByLabel('Название комнаты', {exact: true})
      .evaluate((element) => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext('2d')!;
        const style = getComputedStyle(element);
        ctx.fillStyle = style.backgroundColor;
        ctx.fillRect(0, 0, 1, 1);
        const bg = ctx.getImageData(0, 0, 1, 1).data;
        ctx.fillStyle = style.color;
        ctx.fillRect(0, 0, 1, 1);
        const fg = ctx.getImageData(0, 0, 1, 1).data;
        const luminance = (rgb: Uint8ClampedArray) =>
          Array.from(rgb)
            .slice(0, 3)
            .map((x) => x / 255)
            .map((x) =>
              x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4,
            )
            .reduce((sum, x, i) => sum + x * [0.2126, 0.7152, 0.0722][i], 0);
        const background = luminance(bg),
          text = luminance(fg);
        return {
          background,
          ratio:
            (Math.max(background, text) + 0.05) /
            (Math.min(background, text) + 0.05),
        };
      });
    expect(contrast.background).toBeLessThan(0.1);
    expect(contrast.ratio).toBeGreaterThan(4.5);

    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as {firstTheme: string}).firstTheme,
        ),
      )
      .toBe('dark');
    await expect(
      page.getByRole('button', {name: 'Включить звуки', exact: true}),
    ).toHaveAttribute('aria-pressed', 'false');
    await page
      .getByRole('button', {name: 'Переключить тему', exact: true})
      .click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(
      await page
        .locator('main')
        .evaluate((element) => getComputedStyle(element).transitionDuration),
    ).toBe('0.3s');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as {firstTheme: string}).firstTheme,
        ),
      )
      .toBe('light');
    await page.evaluate(() => localStorage.removeItem('vm-theme'));
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.emulateMedia({colorScheme: 'light'});
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  } finally {
    await context.close();
  }
});
test('room palette reaches a dark participant and sounds follow new events only', async ({
  page,
  browser,
}, info) => {
  await recordSounds(page.context());
  const f = await votingFixture(page, {hideResultsUntilEnd: true});
  await page.goto(`/rooms/${f.room.id}`);
  await page
    .getByRole('tablist', {name: 'Разделы комнаты'})
    .getByRole('tab', {name: 'Настройки', exact: true})
    .click();
  await page.getByRole('button', {name: 'Синий', exact: true}).click();
  const swatch = await page
    .getByRole('button', {name: 'Синий', exact: true})
    .locator('span')
    .last()
    .boundingBox();
  expect(swatch?.width).toBeGreaterThanOrEqual(24);
  expect(swatch?.height).toBe(swatch?.width);
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'blue');
  const guestContext = await browser.newContext({colorScheme: 'dark'});
  await recordSounds(guestContext);
  try {
    const guest = await guestContext.newPage();
    await guest.goto(f.url);
    await expect(
      guest.getByRole('radio', {name: 'Yes', exact: true}),
    ).toBeVisible();
    await expect(guest.locator('html')).toHaveAttribute('data-accent', 'blue');
    // Admin and participant controls stay beside their logo
    for (const target of [page, guest]) {
      const header = target.locator('header').first();
      const logo = await header
        .getByRole('link', {name: 'На главную'})
        .boundingBox();
      const controls = await header
        .getByLabel('Вид и звук', {exact: true})
        .boundingBox();
      expect(
        Math.abs(
          logo!.y + logo!.height / 2 - controls!.y - controls!.height / 2,
        ),
      ).toBeLessThan(2);
    }
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as {decodedSounds: string[]}).decodedSounds
              .length,
        ),
      )
      .toBe(6);
    await expect
      .poll(() =>
        guest.evaluate(
          () =>
            (window as unknown as {decodedSounds: string[]}).decodedSounds
              .length,
        ),
      )
      .toBe(6);
    expect(await sounds(page)).toEqual([]);
    expect(await sounds(guest)).toEqual([]);
    await page
      .getByRole('button', {name: 'Включить звуки', exact: true})
      .click();
    await guest
      .getByRole('button', {name: 'Включить звуки', exact: true})
      .click();
    for (const target of [page, guest])
      await target.evaluate(
        () => ((window as unknown as {sounds: string[]}).sounds = []),
      );
    await guest.getByRole('radio', {name: 'Yes', exact: true}).check();
    await guest
      .getByRole('button', {name: 'Отправить ответ', exact: true})
      .click();
    await expect.poll(() => sounds(guest)).toContain('/sounds/submit.mp3');
    await expect.poll(() => sounds(page)).toContain('/sounds/answer.mp3');
    expect(await sounds(guest)).not.toContain('/sounds/answer.mp3');
    const response = await page.request.post(
      `/api/rooms/${f.room.id}/questions/${f.question.id}/lifecycle`,
      {
        headers: {Origin: f.origin},
        data: {action: 'close', revision: f.question.revision},
      },
    );
    expect(response.status()).toBe(200);
    await expect.poll(() => sounds(page)).toContain('/sounds/close.mp3');
    await expect.poll(() => sounds(guest)).toContain('/sounds/close.mp3');
    const closed = (await response.json()).question;
    const reopened = await page.request.post(
      `/api/rooms/${f.room.id}/questions/${f.question.id}/lifecycle`,
      {
        headers: {Origin: f.origin},
        data: {action: 'open', revision: closed.revision},
      },
    );
    expect(reopened.status()).toBe(200);
    await expect.poll(() => sounds(page)).toContain('/sounds/open.mp3');
    await expect.poll(() => sounds(guest)).toContain('/sounds/open.mp3');
    await guest.reload();
    await expect(
      guest.getByRole('button', {name: 'Выключить звуки', exact: true}),
    ).toBeVisible();
    await expect(
      guest.getByRole('tablist', {name: 'Вкладки участника'}),
    ).toBeVisible();
    expect(await sounds(guest)).toEqual([]);
    await guest.screenshot({
      path: info.outputPath('dark-participant.png'),
      animations: 'disabled',
      fullPage: true,
    });
    await page.emulateMedia({colorScheme: 'dark'});
    await page.screenshot({
      path: info.outputPath('dark-settings.png'),
      animations: 'disabled',
      fullPage: true,
    });
    for (const kind of [
      'open',
      'close',
      'minute',
      'tick',
      'answer',
      'submit',
    ]) {
      const audio = await page.request.get(`/sounds/${kind}.mp3`);
      expect(audio.status()).toBe(200);
      expect((await audio.body()).length).toBeGreaterThan(44);
    }
  } finally {
    await guestContext.close();
  }
});

// Alarms must work even while the admin is in room settings
test('room deadline alarms work outside the question tab', async ({page}) => {
  await page.clock.install({time: new Date()});
  await recordSounds(page.context());
  const f = await votingFixture(page);
  const changed = await page.request.post(
    `/api/rooms/${f.room.id}/questions/${f.question.id}/lifecycle`,
    {
      headers: {Origin: f.origin},
      data: {
        action: 'settings',
        revision: f.question.revision,
        closesAt: new Date(Date.now() + 61000).toISOString(),
        shareResults: false,
        publication: 'after_close',
      },
    },
  );
  expect(changed.status()).toBe(200);
  await page.goto(`/rooms/${f.room.id}`);
  await page
    .getByRole('tablist', {name: 'Разделы комнаты'})
    .getByRole('tab', {name: 'Настройки', exact: true})
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as {decodedSounds: string[]}).decodedSounds.length,
      ),
    )
    .toBe(6);
  await page.getByRole('button', {name: 'Включить звуки', exact: true}).click();
  await page.evaluate(
    () => ((window as unknown as {sounds: string[]}).sounds = []),
  );
  await page.clock.runFor(1800);
  await expect.poll(() => sounds(page)).toContain('/sounds/minute.mp3');
  await page.clock.fastForward(50000);
  await expect.poll(() => sounds(page)).toContain('/sounds/tick.mp3');
  await page.clock.runFor(1100);
  expect(
    (await sounds(page)).filter((name) => name.endsWith('/tick.mp3')).length,
  ).toBeGreaterThanOrEqual(2);
  expect(
    (await sounds(page)).filter((name) => name.endsWith('/minute.mp3')),
  ).toHaveLength(1);
});

// The selected action must be visible without relying on its label
test('home actions have icons and a clear dark selection while preferences scroll away', async ({
  page,
}, info) => {
  await page.emulateMedia({colorScheme: 'dark', reducedMotion: 'reduce'});
  await page.goto('/');
  // Controls share the logo row without a separate top band
  const header = page.locator('main > header');
  const logo = header.getByText('votemachine');
  const controls = page.getByLabel('Вид и звук', {exact: true});
  const logoBox = await logo.boundingBox();
  const controlsBox = await controls.boundingBox();
  expect(
    Math.abs(
      logoBox!.y +
        logoBox!.height / 2 -
        controlsBox!.y -
        controlsBox!.height / 2,
    ),
  ).toBeLessThan(2);
  expect(controlsBox!.x).toBeGreaterThan(logoBox!.x + logoBox!.width);
  expect(
    await page
      .locator('main')
      .evaluate((element) => element.getBoundingClientRect().top),
  ).toBe(0);
  expect(
    await controls.evaluate(
      (element) => getComputedStyle(element).borderTopWidth,
    ),
  ).toBe('0px');
  const group = page.getByRole('group', {name: 'Действие с комнатой'});
  const create = group.getByRole('button', {name: 'Создать', exact: true});
  const join = group.getByRole('button', {name: 'Войти', exact: true});
  for (const button of [create, join])
    await expect(button.locator('svg')).toHaveCount(1);
  await expect(create).toHaveAttribute('aria-pressed', 'true');
  const selected = await create.evaluate((element) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = getComputedStyle(
      document.querySelector('main')!,
    ).backgroundColor;
    ctx.fillRect(0, 0, 1, 1);
    ctx.fillStyle = getComputedStyle(element.parentElement!).backgroundColor;
    ctx.fillRect(0, 0, 1, 1);
    const parent = ctx.getImageData(0, 0, 1, 1).data;
    ctx.fillStyle = getComputedStyle(element).backgroundColor;
    ctx.fillRect(0, 0, 1, 1);
    const active = ctx.getImageData(0, 0, 1, 1).data;
    const luminance = (rgb: Uint8ClampedArray) =>
      Array.from(rgb)
        .slice(0, 3)
        .map((x) => x / 255)
        .map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4))
        .reduce((sum, x, i) => sum + x * [0.2126, 0.7152, 0.0722][i], 0);
    const a = luminance(active),
      b = luminance(parent);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
  expect(selected).toBeGreaterThan(1.25);
  await join.click();
  await expect(join).toHaveAttribute('aria-pressed', 'true');
  await expect(create).toHaveAttribute('aria-pressed', 'false');
  await page.screenshot({
    path: info.outputPath('dark-home-actions.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.setViewportSize({width: page.viewportSize()!.width, height: 350});
  const preferences = page.getByLabel('Вид и звук', {exact: true});
  const before = await preferences.boundingBox();
  expect(before!.y).toBeGreaterThanOrEqual(0);
  await page.evaluate(() => window.scrollTo(0, 150));
  await expect
    .poll(() =>
      preferences.evaluate((element) => element.getBoundingClientRect().bottom),
    )
    .toBeLessThan(0);
});

// Check actual surfaces, borders and text for every supported palette
test('all seven accents tint backgrounds and borders in both themes', async ({
  page,
}) => {
  await page.goto('/');
  const palettes = await page.evaluate(() => {
    const input = document.querySelector('input')!;
    return ['light', 'dark'].map((theme) => {
      document.documentElement.dataset.theme = theme;
      return ['green', 'blue', 'violet', 'rose', 'orange', 'amber', 'teal'].map(
        (accent) => {
          document.documentElement.dataset.accent = accent;
          // Flush styles before finishing color transitions
          input.getBoundingClientRect();
          for (const animation of document.getAnimations())
            if (animation.effect?.getTiming().iterations !== Infinity)
              animation.finish();
          const field = getComputedStyle(input),
            body = getComputedStyle(document.body),
            main = getComputedStyle(document.querySelector('main')!);
          return {
            page: body.backgroundColor,
            surface: main.backgroundColor,
            panel: field.backgroundColor,
            border: field.borderTopColor,
            text: field.color,
          };
        },
      );
    });
  });
  for (const theme of palettes)
    for (const key of ['page', 'surface', 'panel', 'border', 'text'] as const)
      expect(new Set(theme.map((palette) => palette[key])).size).toBe(7);
});

// Ready samples must be silent until the user enables sound
test('all compressed sounds decode before enabling sound', async ({page}) => {
  await recordSounds(page.context());
  let downloads = 0;
  page.on('request', (request) => {
    if (request.url().includes('/sounds/')) downloads++;
  });
  await page.goto('/');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as {decodedSounds: string[]}).decodedSounds.length,
      ),
    )
    .toBe(6);
  expect(downloads).toBe(6);
  expect(await sounds(page)).toEqual([]);
  await page.getByRole('button', {name: 'Включить звуки', exact: true}).click();
  await expect.poll(() => sounds(page)).toContain('/sounds/open.mp3');
  expect(downloads).toBe(6);
});
