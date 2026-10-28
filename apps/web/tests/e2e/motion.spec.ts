import {expect, test} from '@playwright/test';
import {votingFixture} from './voting-helpers';

test('tab motion follows selection and does not replay after live updates', async ({
  page,
}) => {
  await page.emulateMedia({reducedMotion: 'no-preference'});
  await page.addInitScript(() => {
    const events: {type: string; id: string; property?: string}[] = [];
    (window as unknown as {motionEvents: typeof events}).motionEvents = events;
    document.addEventListener('animationstart', (event) => {
      const target = event.target as HTMLElement;
      if (target.hasAttribute('data-tab-slide'))
        events.push({type: 'panel', id: target.closest('[role=tabpanel]')!.id});
    });
    document.addEventListener('transitionrun', (event) => {
      const target = event.target as HTMLElement;
      if (target.hasAttribute('data-selection-indicator'))
        events.push({type: 'indicator', id: '', property: event.propertyName});
    });
  });
  const f = await votingFixture(page);
  await page.goto(`/rooms/${f.room.id}`);
  const tabs = page.getByRole('tablist', {
    name: 'Разделы комнаты',
    exact: true,
  });
  await expect(
    page.getByRole('heading', {name: 'Вопросы', exact: true}),
  ).toBeVisible();
  await tabs.getByRole('tab', {name: 'Респонденты', exact: true}).click();
  const panel = page.getByRole('tabpanel', {name: 'Респонденты', exact: true});
  await expect(
    panel.getByRole('heading', {name: 'Alice', exact: true}),
  ).toBeVisible();
  const events = () =>
    page.evaluate(
      () =>
        (
          window as unknown as {
            motionEvents: {type: string; id: string; property?: string}[];
          }
        ).motionEvents,
    );
  await expect
    .poll(async () =>
      (await events()).some(
        (event) => event.type === 'indicator' && event.property === 'transform',
      ),
    )
    .toBe(true);
  await expect
    .poll(
      async () =>
        (await events()).filter(
          (event) =>
            event.type === 'panel' &&
            event.id === 'room-sections-panel-respondents',
        ).length,
    )
    .toBe(1);
  const before = 1;
  const indicator = tabs.locator('[data-selection-indicator]');
  await expect
    .poll(async () => {
      const marker = await indicator.boundingBox();
      const selected = await tabs
        .getByRole('tab', {name: 'Респонденты', exact: true})
        .boundingBox();
      return (
        Math.abs(marker!.x - selected!.x) +
        Math.abs(marker!.width - selected!.width)
      );
    })
    .toBeLessThan(1);
  expect(
    (
      await page.request.post(`/api/rooms/${f.room.id}/links`, {
        headers: {Origin: f.origin},
        data: {mode: 'personal', names: ['Live update']},
      })
    ).status(),
  ).toBe(201);
  await expect(
    panel.getByRole('heading', {name: 'Live update', exact: true}),
  ).toBeVisible();
  expect(
    (await events()).filter(
      (event) =>
        event.type === 'panel' &&
        event.id === 'room-sections-panel-respondents',
    ),
  ).toHaveLength(before);
  for (const name of ['Результаты', 'Настройки', 'Вопросы'])
    await tabs.getByRole('tab', {name, exact: true}).click();
  await expect(
    page.getByRole('tabpanel', {name: 'Вопросы', exact: true}),
  ).toBeVisible();
  await expect(
    page.getByRole('tabpanel', {name: 'Настройки', exact: true}),
  ).toHaveCount(0);
  await tabs.getByRole('tab', {name: 'Вопросы', exact: true}).focus();
  await page.keyboard.press('ArrowRight');
  await expect(
    tabs.getByRole('tab', {name: 'Респонденты', exact: true}),
  ).toBeFocused();
});

test('reduced motion keeps tabs and dialogs still', async ({page}) => {
  await page.emulateMedia({reducedMotion: 'reduce'});
  const f = await votingFixture(page);
  await page.goto(`/rooms/${f.room.id}`);
  const tabs = page.getByRole('tablist', {
    name: 'Разделы комнаты',
    exact: true,
  });
  await tabs.getByRole('tab', {name: 'Респонденты', exact: true}).click();
  const panel = page.getByRole('tabpanel', {name: 'Респонденты', exact: true});
  await expect(panel.locator(':scope > [data-tab-slide]')).toHaveCSS(
    'animation-name',
    'none',
  );
  await expect(tabs.locator('[data-selection-indicator]')).toHaveCSS(
    'transition-duration',
    '0s',
  );
  await panel
    .getByRole('button', {name: 'QR Code: Alice', exact: true})
    .click();
  const dialog = page.getByRole('dialog', {name: 'QR Code', exact: true});
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveCSS('animation-name', 'none');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('page entry stays still before and after its first snapshot loads', async ({
  page,
  browser,
}) => {
  await page.emulateMedia({reducedMotion: 'no-preference'});
  const f = await votingFixture(page);
  await page.addInitScript(() => {
    const events: string[] = [];
    (window as unknown as {entrySlides: string[]}).entrySlides = events;
    document.addEventListener('animationstart', (event) => {
      const node = event.target as HTMLElement;
      if (node.hasAttribute('data-tab-slide'))
        events.push(node.closest('[role=tabpanel]')!.id);
    });
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/rooms/${f.room.id}/questions?*`, async (route) => {
    await held;
    await route.continue();
  });
  await page.goto(`/rooms/${f.room.id}`);
  const panel = page.getByRole('tabpanel', {name: 'Вопросы', exact: true});
  await expect(
    panel.getByRole('status', {name: 'Загружаем вопросы…', exact: true}),
  ).toBeVisible();
  await expect(panel.locator(':scope > [data-tab-slide]')).toHaveCSS(
    'animation-name',
    'none',
  );
  release();
  await expect(
    panel.getByRole('heading', {name: 'Choose a result', exact: true}),
  ).toBeVisible();
  await expect(panel.locator(':scope > [data-tab-slide]')).toHaveCSS(
    'animation-name',
    'none',
  );
  expect(
    await page.evaluate(
      () => (window as unknown as {entrySlides: string[]}).entrySlides,
    ),
  ).toEqual([]);
  const device = await browser.newContext();
  try {
    await device.addInitScript(() => {
      const events: string[] = [];
      (window as unknown as {entrySlides: string[]}).entrySlides = events;
      document.addEventListener('animationstart', (event) => {
        const node = event.target as HTMLElement;
        if (node.hasAttribute('data-tab-slide'))
          events.push(node.closest('[role=tabpanel]')!.id);
      });
    });
    const participant = await device.newPage();
    await participant.emulateMedia({reducedMotion: 'no-preference'});
    await participant.goto(f.url);
    await expect(
      participant.getByRole('radio', {name: 'Yes', exact: true}),
    ).toBeVisible();
    expect(
      await participant.evaluate(
        () => (window as unknown as {entrySlides: string[]}).entrySlides,
      ),
    ).toEqual([]);
  } finally {
    await device.close();
  }
});

test('tab slide direction follows order and releases clipping after entry', async ({
  page,
}, info) => {
  await page.emulateMedia({reducedMotion: 'no-preference'});
  const f = await votingFixture(page);
  await page.goto(`/rooms/${f.room.id}`);
  await expect(
    page.getByRole('heading', {name: 'Вопросы', exact: true}),
  ).toBeVisible();
  const tabs = page.getByRole('tablist', {
    name: 'Разделы комнаты',
    exact: true,
  });
  // Pause the next entry to inspect the actual motion in each direction
  async function enter(name: string) {
    const panelId = await tabs
      .getByRole('tab', {name, exact: true})
      .getAttribute('aria-controls');
    await page.evaluate((expected) => {
      (window as unknown as {slideFrame: Promise<number>}).slideFrame =
        new Promise<number>((resolve) => {
          function started(event: AnimationEvent) {
            const node = event.target as HTMLElement;
            if (
              !node.hasAttribute('data-tab-slide') ||
              node.closest('[hidden]') ||
              node.closest('[role=tabpanel]')?.id !== expected
            )
              return;
            document.removeEventListener('animationstart', started);
            const animation = node.getAnimations()[0];
            animation.pause();
            animation.currentTime = 180;
            resolve(
              new DOMMatrixReadOnly(getComputedStyle(node).transform).m41,
            );
          }
          document.addEventListener('animationstart', started);
        });
    }, panelId);
    await tabs.getByRole('tab', {name, exact: true}).click();
    const x = await page.evaluate(
      () => (window as unknown as {slideFrame: Promise<number>}).slideFrame,
    );
    const panel = page.getByRole('tabpanel', {name, exact: true});
    await page.screenshot({
      path: info.outputPath(
        x > 0 ? 'slide-from-right.png' : 'slide-from-left.png',
      ),
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await panel
      .locator(':scope > [data-tab-slide]')
      .evaluate((node) =>
        node.getAnimations().forEach((animation) => animation.finish()),
      );
    await expect(panel).not.toHaveAttribute('data-motion', 'enter');
    return x;
  }
  expect(await enter('Настройки')).toBeGreaterThan(0);
  expect(await enter('Вопросы')).toBeLessThan(0);
});

test('outgoing content stays until both slides finish while data keeps loading', async ({
  page,
}, info) => {
  await page.emulateMedia({reducedMotion: 'no-preference'});
  const f = await votingFixture(page);
  await page.goto(`/rooms/${f.room.id}`);
  await expect(
    page.getByRole('heading', {name: 'Choose a result', exact: true}),
  ).toBeVisible();
  const old = page.locator('#room-sections-panel-questions');
  await old
    .locator(':scope > [data-tab-slide]')
    .evaluate((node) =>
      node.getAnimations().forEach((animation) => animation.finish()),
    );
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/rooms/${f.room.id}/links?*`, async (route) => {
    await held;
    await route.continue();
  });
  const viewport = page.locator('[data-tab-panels="room-sections"]');
  await viewport.evaluate((node) => {
    (window as unknown as {pair: Promise<number[]>}).pair = new Promise<
      number[]
    >((resolve) => {
      const frames: number[] = [];
      function started(event: Event) {
        const target = event.target as HTMLElement;
        if (
          !target.hasAttribute('data-tab-slide') ||
          target.closest('[data-tab-panels]') !== node
        )
          return;
        const animation = target.getAnimations()[0];
        animation.pause();
        animation.currentTime = 180;
        frames.push(
          new DOMMatrixReadOnly(getComputedStyle(target).transform).m41,
        );
        if (frames.length === 2) {
          node.removeEventListener('animationstart', started);
          resolve(frames);
        }
      }
      node.addEventListener('animationstart', started);
    });
  });
  await page.getByRole('tab', {name: 'Респонденты', exact: true}).click();
  await expect(old).toHaveAttribute('inert');
  await expect(old).toHaveAttribute('aria-hidden', 'true');
  const frames = await page.evaluate(
    () => (window as unknown as {pair: Promise<number[]>}).pair,
  );
  expect(frames.some((x) => x < 0)).toBe(true);
  expect(frames.some((x) => x > 0)).toBe(true);
  await page.waitForTimeout(600);
  await expect(old).toBeVisible();
  await page.screenshot({path: info.outputPath('paired-slide.png')});
  await viewport.evaluate((node) =>
    node.getAnimations({subtree: true}).forEach((animation) => {
      const target = (animation.effect as KeyframeEffect | null)
        ?.target as Element | null;
      if (target?.hasAttribute('data-tab-slide')) animation.currentTime = 450;
    }),
  );
  await expect(old).toBeVisible();
  await viewport.evaluate((node) =>
    node.getAnimations({subtree: true}).forEach((animation) => {
      const target = (animation.effect as KeyframeEffect | null)
        ?.target as Element | null;
      if (target?.hasAttribute('data-tab-slide')) animation.finish();
    }),
  );
  await expect(old).toBeHidden();
  await expect(
    page.getByRole('status', {name: 'Загружаем респондентов…', exact: true}),
  ).toBeVisible();
  release();
  await expect(
    page.getByRole('heading', {name: 'Alice', exact: true}),
  ).toBeVisible();
});

test('finished outgoing slides never snap back while React cleanup is pending', async ({
  page,
}) => {
  await page.emulateMedia({reducedMotion: 'no-preference'});
  const f = await votingFixture(page);
  await page.goto(`/rooms/${f.room.id}`);
  await expect(
    page.getByRole('heading', {name: 'Choose a result', exact: true}),
  ).toBeVisible();
  await page.waitForFunction(() => {
    const panel = document.getElementById('room-sections-panel-questions')!;
    return (
      !panel.hasAttribute('data-waiting') && !panel.hasAttribute('data-motion')
    );
  });
  const viewport = page.locator('[data-tab-panels="room-sections"]');
  for (const {from, to, label, sign} of [
    {from: 'questions', to: 'respondents', label: 'Респонденты', sign: -1},
    {from: 'respondents', to: 'questions', label: 'Вопросы', sign: 1},
  ]) {
    const old = page.locator(`#room-sections-panel-${from}`);
    await old.evaluate((node) => {
      // Hold React cleanup so the compositor's final frame can be checked
      node.addEventListener(
        'animationend',
        (event) => event.stopPropagation(),
        {capture: true, once: true},
      );
    });
    await viewport.evaluate((node) => {
      (window as unknown as {pairReady: Promise<void>}).pairReady =
        new Promise<void>((resolve) => {
          let count = 0;
          function started(event: Event) {
            const target = event.target as HTMLElement;
            if (
              !target.hasAttribute('data-tab-slide') ||
              target.closest('[data-tab-panels]') !== node
            )
              return;
            const animation = target.getAnimations()[0];
            animation.pause();
            animation.currentTime = 180;
            if (++count === 2) {
              node.removeEventListener('animationstart', started);
              resolve();
            }
          }
          node.addEventListener('animationstart', started);
        });
    });
    await page.getByRole('tab', {name: label, exact: true}).click();
    await page.evaluate(
      () => (window as unknown as {pairReady: Promise<void>}).pairReady,
    );
    const frames = await old
      .locator(':scope > [data-tab-slide]')
      .evaluate(async (node) => {
        const animation = node.getAnimations()[0];
        animation.finish();
        await animation.finished;
        const samples: {x: number; width: number; hidden: boolean}[] = [];
        // Check the boundary frame and two frames before React is allowed to remove it
        for (let frame = 0; frame < 3; frame++) {
          samples.push({
            x: new DOMMatrixReadOnly(getComputedStyle(node).transform).m41,
            width: (node as HTMLElement).offsetWidth,
            hidden: node.parentElement!.hasAttribute('hidden'),
          });
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          );
        }
        return samples;
      });
    for (const frame of frames) {
      expect(frame.hidden).toBe(false);
      expect(frame.x * sign).toBeGreaterThanOrEqual(frame.width - 1);
    }
    const incoming = page.locator(`#room-sections-panel-${to}`);
    await incoming
      .locator(':scope > [data-tab-slide]')
      .evaluate((node) =>
        node.getAnimations().forEach((animation) => animation.finish()),
      );
    await expect(old).toBeHidden();
    await expect(incoming).not.toHaveAttribute('data-motion');
  }
});

test('opening a question editor stays still and its later tab switches still slide', async ({
  page,
}) => {
  await page.emulateMedia({reducedMotion: 'no-preference'});
  const f = await votingFixture(page);
  await page.goto(`/rooms/${f.room.id}`);
  await expect(
    page.getByRole('heading', {name: 'Choose a result', exact: true}),
  ).toBeVisible();
  await page.evaluate(() => {
    const events: string[] = [];
    (window as unknown as {editorSlides: string[]}).editorSlides = events;
    document.addEventListener('animationstart', (event) => {
      const node = event.target as HTMLElement;
      const panel = node.closest('[role=tabpanel]');
      if (
        node.hasAttribute('data-tab-slide') &&
        panel &&
        !panel.id.startsWith('room-sections-')
      )
        events.push(panel.id);
    });
  });
  // Check both an existing question and a newly created editor
  for (const action of ['Просмотреть', 'Создать вопрос']) {
    await page.evaluate(() => {
      (window as unknown as {editorSlides: string[]}).editorSlides.length = 0;
    });
    await page.getByRole('button', {name: action, exact: true}).click();
    const tabs = page.getByRole('tablist', {
      name: 'Разделы вопроса',
      exact: true,
    });
    await expect(tabs).toBeVisible();
    const editing = page.getByRole('tabpanel', {
      name: 'Редактирование',
      exact: true,
    });
    await expect(editing.locator(':scope > [data-tab-slide]')).toHaveCSS(
      'animation-name',
      'none',
    );
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    expect(
      await page.evaluate(
        () => (window as unknown as {editorSlides: string[]}).editorSlides,
      ),
    ).toEqual([]);
    await tabs.getByRole('tab', {name: 'Настройки', exact: true}).click();
    const target = await tabs
      .getByRole('tab', {name: 'Настройки', exact: true})
      .getAttribute('aria-controls');
    await expect
      .poll(() =>
        page.evaluate(
          (id) =>
            (
              window as unknown as {editorSlides: string[]}
            ).editorSlides.includes(id!),
          target,
        ),
      )
      .toBe(true);
    await page.getByRole('button', {name: 'Вернуться', exact: true}).click();
    await expect(tabs).toHaveCount(0);
  }
});

test('question settings opens on the first click after Markdown preview', async ({
  page,
}) => {
  await page.emulateMedia({reducedMotion: 'no-preference'});
  const f = await votingFixture(page);
  const created = await page.request.post(`/api/rooms/${f.room.id}/questions`, {
    headers: {Origin: f.origin},
    data: {
      content: Array.from(
        {length: 60},
        (_, index) => `Paragraph ${index}\n\n`,
      ).join(''),
      choiceMode: 'single',
      minChoices: 1,
      maxChoices: 1,
      shareResults: false,
      publication: 'after_close',
      hideResultsUntilEnd: false,
      allowAnswerChange: false,
      anonymous: false,
      choices: [{content: 'Yes'}, {content: 'No'}],
    },
  });
  expect(created.status()).toBe(201);
  await page.goto(`/rooms/${f.room.id}`);
  await page.getByRole('button', {name: 'Редактировать', exact: true}).click();
  const tabs = page.getByRole('tablist', {
    name: 'Разделы вопроса',
    exact: true,
  });
  const preview = page
    .getByRole('group', {name: 'Режим редактора: Текст вопроса', exact: true})
    .getByRole('button', {name: 'Предпросмотр', exact: true});
  for (const name of ['Настройки', 'Управление']) {
    // Safari does not focus clicked buttons by default
    await page
      .getByRole('textbox', {name: 'Текст вопроса', exact: true})
      .focus();
    await preview.click();
    await expect(preview).toBeFocused();
    const target = tabs.getByRole('tab', {name, exact: true});
    // Use one physical click without locator retries
    await target.scrollIntoViewIfNeeded();
    const box = (await target.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(target).toHaveAttribute('aria-selected', 'true');
    await expect(target).toBeFocused();
    await expect(page.getByRole('tabpanel', {name, exact: true})).toBeVisible();
    await tabs.getByRole('tab', {name: 'Редактирование', exact: true}).click();
    await page
      .getByRole('group', {name: 'Режим редактора: Текст вопроса', exact: true})
      .getByRole('button', {name: 'Текст', exact: true})
      .click();
  }
});

test('editor selectors appear in place and animate only later selections', async ({
  page,
}) => {
  await page.emulateMedia({reducedMotion: 'no-preference'});
  const f = await votingFixture(page);
  await page.goto(`/rooms/${f.room.id}`);
  await page.evaluate(() => {
    const events: string[] = [];
    (window as unknown as {selectorEntries: string[]}).selectorEntries = events;
    document.addEventListener('transitionrun', (event) => {
      const marker = event.target as HTMLElement;
      const label = marker.parentElement?.getAttribute('aria-label');
      if (
        marker.hasAttribute('data-selection-indicator') &&
        (label === 'Разделы вопроса' || label?.startsWith('Режим редактора:'))
      )
        events.push(event.propertyName);
    });
  });
  await page.getByRole('button', {name: 'Создать вопрос', exact: true}).click();
  const tabs = page.getByRole('tablist', {
    name: 'Разделы вопроса',
    exact: true,
  });
  const marker = tabs.locator('[data-selection-indicator]');
  await expect(marker).toBeVisible();
  // Wait until later movement is enabled before inspecting the entry events
  await expect
    .poll(() =>
      marker.evaluate((node) => (node as HTMLElement).style.transition),
    )
    .toBe('');
  expect(
    await page.evaluate(
      () => (window as unknown as {selectorEntries: string[]}).selectorEntries,
    ),
  ).toEqual([]);
  await tabs.getByRole('tab', {name: 'Настройки', exact: true}).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as {selectorEntries: string[]}).selectorEntries,
      ),
    )
    .toContain('transform');
});

test('a stalled result request cannot trap a participant on the previous tab', async ({
  page,
  browser,
}) => {
  const f = await votingFixture(page, {shareResults: true});
  expect(
    (
      await page.request.patch(`/api/rooms/${f.room.id}/experience`, {
        headers: {Origin: f.origin},
        data: {showAllResults: true},
      })
    ).status(),
  ).toBe(200);
  const device = await browser.newContext();
  try {
    const participant = await device.newPage();
    await participant.emulateMedia({reducedMotion: 'no-preference'});
    await participant.goto(f.url);
    const tabs = participant.getByRole('tablist', {name: 'Вкладки участника'});
    await expect(
      tabs.getByRole('tab', {name: 'Результаты', exact: true}),
    ).toBeVisible();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await participant.route(
      `**/api/vote/${f.link.id}/results?*`,
      async (route) => {
        await held;
        await route.fulfill({
          status: 503,
          json: {error: 'Results unavailable'},
        });
      },
    );
    await tabs.getByRole('tab', {name: 'Результаты', exact: true}).click();
    const current = participant.locator('#participant-tabs-panel-question');
    const results = participant.getByRole('tabpanel', {
      name: 'Результаты',
      exact: true,
    });
    // Show the new loading view even when its requests never finish
    await expect(current).toBeHidden({timeout: 3000});
    await expect(
      results.getByRole('status', {
        name: 'Загружаем список результатов…',
        exact: true,
      }),
    ).toBeVisible();
    release();
    await expect(
      results.getByText('Не удалось обновить результаты', {exact: true}),
    ).toBeVisible();
    await tabs.getByRole('tab', {name: 'Вопрос', exact: true}).click();
    await expect(current).toBeVisible();
    await expect(
      participant.getByRole('radio', {name: 'Yes', exact: true}),
    ).toBeVisible();
  } finally {
    await device.close();
  }
});

test('pending photos and scroll never block editor or participant tabs', async ({
  page,
  browser,
}) => {
  const f = await votingFixture(page, {shareResults: true});
  const headers = {Origin: f.origin};
  const uploaded = await page.request.post(`/api/rooms/${f.room.id}/assets`, {
    headers,
    multipart: {
      file: {
        name: 'pending.png',
        mimeType: 'image/png',
        buffer: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWMwTptpnDaTAUIBAB/uBMm6iK1UAAAAAElFTkSuQmCC',
          'base64',
        ),
      },
    },
  });
  expect(uploaded.status()).toBe(201);
  const asset = await uploaded.json();
  const created = await page.request.post(`/api/rooms/${f.room.id}/questions`, {
    headers,
    data: {
      content:
        `![Pending photo](asset:${asset.id})\n\n` +
        Array.from({length: 30}, (_, i) => `Paragraph ${i}\n\n`).join(''),
      choiceMode: 'single',
      minChoices: 1,
      maxChoices: 1,
      shareResults: true,
      publication: 'after_close',
      hideResultsUntilEnd: false,
      allowAnswerChange: false,
      anonymous: false,
      choices: [{content: 'Yes'}, {content: 'No'}],
    },
  });
  expect(created.status()).toBe(201);
  const {question} = await created.json();
  let releaseAdmin!: () => void;
  const heldAdmin = new Promise<void>((resolve) => {
    releaseAdmin = resolve;
  });
  await page.route(`**/assets/${asset.id}/info`, async (route) => {
    await heldAdmin;
    await route.continue();
  });
  await page.goto(`/rooms/${f.room.id}`);
  await page.getByRole('button', {name: 'Редактировать', exact: true}).click();
  await page
    .getByRole('group', {name: 'Режим редактора: Текст вопроса', exact: true})
    .getByRole('button', {name: 'Предпросмотр', exact: true})
    .click();
  await expect(
    page.getByRole('status').filter({hasText: 'Загружаем файл…'}),
  ).toBeVisible();
  await page.evaluate(() => window.scrollBy(0, 600));
  const editorTabs = page.getByRole('tablist', {name: 'Разделы вопроса'});
  const settings = editorTabs.getByRole('tab', {
    name: 'Настройки',
    exact: true,
  });
  await settings.scrollIntoViewIfNeeded();
  const box = (await settings.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(settings).toHaveAttribute('aria-selected', 'true');
  await expect(
    page.getByLabel('Публиковать результаты участникам', {exact: true}),
  ).toBeVisible();
  await page.getByRole('button', {name: 'Вернуться', exact: true}).click();
  releaseAdmin();
  expect(
    (
      await page.request.post(
        `/api/rooms/${f.room.id}/questions/${f.question.id}/lifecycle`,
        {headers, data: {action: 'close', revision: f.question.revision}},
      )
    ).status(),
  ).toBe(200);
  expect(
    (
      await page.request.post(
        `/api/rooms/${f.room.id}/questions/${question.id}/lifecycle`,
        {headers, data: {action: 'open', revision: question.revision}},
      )
    ).status(),
  ).toBe(200);
  expect(
    (
      await page.request.patch(`/api/rooms/${f.room.id}/experience`, {
        headers,
        data: {showAllResults: true},
      })
    ).status(),
  ).toBe(200);
  const device = await browser.newContext({viewport: page.viewportSize()!});
  let releasePhoto!: () => void;
  const heldPhoto = new Promise<void>((resolve) => {
    releasePhoto = resolve;
  });
  try {
    const participant = await device.newPage();
    // Hold the actual image body after metadata has already loaded
    await participant.route(`**/assets/${asset.id}`, async (route) => {
      await heldPhoto;
      await route.continue();
    });
    await participant.goto(f.url);
    const image = participant.getByRole('img', {
      name: 'Pending photo',
      exact: true,
    });
    await expect(image).toBeVisible();
    expect(
      await image.evaluate((node) => (node as HTMLImageElement).complete),
    ).toBe(false);
    await participant.evaluate(() => window.scrollBy(0, 600));
    const tabs = participant.getByRole('tablist', {name: 'Вкладки участника'});
    for (const name of ['Результаты', 'Список вопросов', 'Вопрос']) {
      const tab = tabs.getByRole('tab', {name, exact: true});
      await tab.scrollIntoViewIfNeeded();
      const bounds = (await tab.boundingBox())!;
      await participant.mouse.click(
        bounds.x + bounds.width / 2,
        bounds.y + bounds.height / 2,
      );
      await expect(tab).toHaveAttribute('aria-selected', 'true');
      await expect(
        participant.getByRole('tabpanel', {name, exact: true}),
      ).toBeVisible();
    }
    // The photo is still pending after all three first-click switches
    expect(
      await image.evaluate((node) => (node as HTMLImageElement).complete),
    ).toBe(false);
  } finally {
    releasePhoto();
    await device.close();
  }
});
