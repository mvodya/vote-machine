import {expect, test} from '@playwright/test';
import {votingFixture} from './voting-helpers';

test('published results reach a closed-question non-voter and anonymous choices stay in their writing session', async ({
  page,
  browser,
}) => {
  const f = await votingFixture(page, {
    anonymous: true,
    shareResults: true,
    publication: 'after_close',
  });
  const device = await browser.newContext();
  const second = await browser.newContext();
  try {
    const participant = await device.newPage();
    await participant.goto(f.url);
    await participant.getByRole('radio', {name: 'Yes', exact: true}).check();
    await participant
      .getByRole('button', {name: 'Отправить ответ', exact: true})
      .click();
    await expect(
      participant.getByRole('heading', {name: 'Все вопросы пройдены'}),
    ).toBeVisible();
    const another = await second.newPage();
    await another.goto(f.url);
    await another
      .getByRole('tab', {name: 'Список вопросов', exact: true})
      .click();
    await another
      .getByRole('button', {name: 'Choose a result', exact: true})
      .last()
      .click();
    await expect(
      another.getByText('Ответ сохранен с другого устройства', {exact: true}),
    ).toBeVisible();
    await expect(
      another.getByRole('radio', {name: 'Yes', exact: true}),
    ).not.toBeChecked();
    await page.goto(`/rooms/${f.room.id}`);
    await page
      .getByRole('tablist', {name: 'Разделы комнаты'})
      .getByRole('tab', {name: 'Результаты', exact: true})
      .click();
    await page
      .getByRole('button', {name: 'Результаты: Choose a result', exact: true})
      .click();
    const adminResults = page.getByRole('region', {
      name: 'Итоги вопроса',
      exact: true,
    });
    await expect(
      adminResults.getByText('Ответы: 1', {exact: true}),
    ).toBeVisible();
    await expect(adminResults.getByText('Индивидуальные ответы')).toHaveCount(
      0,
    );
    const headers = {Origin: f.origin};
    expect(
      (
        await page.request.post(
          `/api/rooms/${f.room.id}/questions/${f.question.id}/lifecycle`,
          {headers, data: {action: 'close', revision: f.question.revision}},
        )
      ).status(),
    ).toBe(200);
    const nonVoter = await page.request.post(`/api/rooms/${f.room.id}/links`, {
      headers,
      data: {mode: 'personal', names: ['Non-voter']},
    });
    const {
      links: [link],
    } = await nonVoter.json();
    const {token} = await (
      await page.request.get(`/api/rooms/${f.room.id}/links/${link.id}/secret`)
    ).json();
    await another.goto(`${f.origin}/vote/${link.id}#key=${token}`);
    await another.getByRole('tab', {name: 'Результаты', exact: true}).click();
    await another
      .getByRole('button', {name: 'Результаты: Choose a result', exact: true})
      .click();
    await expect(
      another
        .getByRole('region', {name: 'Итоги вопроса', exact: true})
        .getByText('Ответы: 1', {exact: true}),
    ).toBeVisible();
    const csv = await another.request.get(
      `/api/vote/${link.id}/results?question=${f.question.id}&format=csv`,
    );
    expect(csv.status()).toBe(200);
    expect(await csv.text()).not.toContain(f.link.id);
  } finally {
    await device.close();
    await second.close();
  }
});

test('hidden results and exports clear after reopen', async ({page}) => {
  const f = await votingFixture(page, {hideResultsUntilEnd: true});
  await page.goto(`/rooms/${f.room.id}`);
  await page
    .getByRole('tablist', {name: 'Разделы комнаты'})
    .getByRole('tab', {name: 'Результаты', exact: true})
    .click();
  await page
    .getByRole('button', {name: 'Результаты: Choose a result', exact: true})
    .click();
  const results = page.getByRole('region', {
    name: 'Итоги вопроса',
    exact: true,
  });
  await expect(
    results.getByText('Результаты пока недоступны', {exact: true}),
  ).toBeVisible();
  expect(
    (
      await page.request.get(
        `/api/rooms/${f.room.id}/results?question=${f.question.id}&format=csv`,
      )
    ).status(),
  ).toBe(403);
  const close = await page.request.post(
    `/api/rooms/${f.room.id}/questions/${f.question.id}/lifecycle`,
    {
      headers: {Origin: f.origin},
      data: {action: 'close', revision: f.question.revision},
    },
  );
  const {question} = await close.json();
  await expect(results.getByText('Ответы: 0', {exact: true})).toBeVisible();
  expect(
    (
      await page.request.post(
        `/api/rooms/${f.room.id}/questions/${question.id}/lifecycle`,
        {
          headers: {Origin: f.origin},
          data: {action: 'open', revision: question.revision},
        },
      )
    ).status(),
  ).toBe(200);
  await expect(results.getByText('Ответы: 0', {exact: true})).toHaveCount(0);
  await expect(
    results.getByText('Результаты пока недоступны', {exact: true}),
  ).toBeVisible();
});

test('an answer with no selected options remains available in admin results and CSV', async ({
  page,
  browser,
}) => {
  const f = await votingFixture(page, {
    choiceMode: 'multiple',
    minChoices: 0,
    maxChoices: 2,
  });
  const device = await browser.newContext();
  try {
    const participant = await device.newPage();
    await participant.goto(f.url);
    await participant
      .getByRole('button', {name: 'Отправить ответ', exact: true})
      .click();
    await expect(
      participant.getByRole('heading', {
        name: 'Все вопросы пройдены',
        exact: true,
      }),
    ).toBeVisible();
    const path = `/api/rooms/${f.room.id}/results?question=${f.question.id}`;
    const response = await page.request.get(path);
    expect(response.status()).toBe(200);
    const {result} = await response.json();
    expect(result.total).toBe(1);
    expect(result.people[0].choices).toEqual([]);
    expect(
      result.options.every((option: {count: number}) => option.count === 0),
    ).toBe(true);
    expect((await page.request.get(`${path}&format=csv`)).status()).toBe(200);
    await page.goto(`/rooms/${f.room.id}`);
    await page
      .getByRole('tablist', {name: 'Разделы комнаты'})
      .getByRole('tab', {name: 'Результаты', exact: true})
      .click();
    await page
      .getByRole('button', {name: 'Результаты: Choose a result', exact: true})
      .click();
    await expect(
      page
        .getByRole('region', {name: 'Итоги вопроса', exact: true})
        .getByText('Ответы: 1', {exact: true}),
    ).toBeVisible();
  } finally {
    await device.close();
  }
});
