import {expect, test, type Page} from '@playwright/test';
import {votingFixture} from './voting-helpers';

// Add another real open question without replacing participant access
async function later(
  page: Page,
  room: string,
  content: string,
  extra: Record<string, unknown> = {},
) {
  const headers = {Origin: new URL(page.url()).origin};
  const created = await page.request.post(`/api/rooms/${room}/questions`, {
    headers,
    data: {
      content,
      choiceMode: 'single',
      minChoices: 1,
      maxChoices: 1,
      shareResults: false,
      publication: 'after_close',
      hideResultsUntilEnd: false,
      allowAnswerChange: false,
      anonymous: false,
      choices: [{content: 'Yes'}, {content: 'No'}],
      ...extra,
    },
  });
  expect(created.status()).toBe(201);
  const {question} = await created.json();
  const opened = await page.request.post(
    `/api/rooms/${room}/questions/${question.id}/lifecycle`,
    {headers, data: {action: 'open', revision: question.revision}},
  );
  expect(opened.status()).toBe(200);
  return (await opened.json()).question;
}

test('personal journey keeps selections through updates, advances, edits history and receives new questions', async ({
  page,
  browser,
}, info) => {
  const f = await votingFixture(page, {
    content: 'First question',
    allowAnswerChange: true,
  });
  await later(page, f.room.id, 'Second question');
  const device = await browser.newContext();
  const participant = await device.newPage();
  try {
    await participant.goto(f.url);
    const current = participant.getByRole('region', {
      name: 'Текущий вопрос',
      exact: true,
    });
    await expect(
      current.getByText('First question', {exact: true}),
    ).toBeVisible();
    await expect(
      current.getByRole('button', {name: 'Пропустить вопрос'}),
    ).toHaveCount(0);
    await expect(
      participant.getByRole('button', {name: 'Second question', exact: true}),
    ).toBeDisabled();
    await current.getByText('Yes', {exact: true}).click();
    await expect(
      current.getByRole('radio', {name: 'Yes', exact: true}),
    ).toBeChecked();
    await participant.waitForResponse(
      (response) =>
        response.url().includes('/questions?') &&
        response.request().method() === 'GET',
    );
    await expect(
      current.getByRole('radio', {name: 'Yes', exact: true}),
    ).toBeChecked();
    await current
      .getByRole('button', {name: 'Отправить ответ', exact: true})
      .click();
    await expect(
      current.getByText('Second question', {exact: true}),
    ).toBeVisible();
    await current.getByRole('radio', {name: 'No', exact: true}).check();
    await current
      .getByRole('button', {name: 'Отправить ответ', exact: true})
      .click();
    await expect(
      participant.getByRole('heading', {name: 'Ожидание вопросов'}),
    ).toBeVisible();
    await participant
      .getByRole('tab', {name: 'Мои ответы', exact: true})
      .click();
    await participant
      .getByRole('button', {name: 'First question', exact: true})
      .click();
    await expect(
      current.getByRole('radio', {name: 'Yes', exact: true}),
    ).toBeChecked();
    await current.getByRole('radio', {name: 'No', exact: true}).check();
    await current
      .getByRole('button', {name: 'Изменить ответ', exact: true})
      .click();
    await expect(
      participant.getByRole('heading', {name: 'Ожидание вопросов'}),
    ).toBeVisible();
    const answer = await (
      await participant.request.get(
        `${f.origin}/api/vote/${f.link.id}/answers/${f.question.id}`,
      )
    ).json();
    expect(answer.answer.choices).toEqual([f.question.choices[1].id]);
    await later(page, f.room.id, 'Next day question', {anonymous: true});
    await expect(
      current.getByText('Next day question', {exact: true}),
    ).toBeVisible({timeout: 10000});
    await expect(
      current.getByText('Администратор не видит, с какой ссылки получен ответ'),
    ).toBeVisible();
    await expect(
      current.getByText('Администратор не может редактировать этот вопрос'),
    ).toHaveClass(/text-xs/);
    await participant.screenshot({
      path: info.outputPath('participant-journey.png'),
      fullPage: true,
    });
  } finally {
    await device.close();
  }
});

test('skip is shown only when allowed and does not count as an answer', async ({
  page,
  browser,
}) => {
  const f = await votingFixture(page, {
    content: 'Optional question',
    allowSkip: true,
  });
  await later(page, f.room.id, 'Required question');
  const device = await browser.newContext();
  const participant = await device.newPage();
  try {
    await participant.goto(f.url);
    const current = participant.getByRole('region', {
      name: 'Текущий вопрос',
      exact: true,
    });
    await current
      .getByRole('button', {name: 'Пропустить вопрос', exact: true})
      .click();
    await expect(
      current.getByText('Required question', {exact: true}),
    ).toBeVisible();
    await expect(
      participant.getByText('Ответов на открытые вопросы: 0 из 2'),
    ).toBeVisible();
    expect(
      (
        await (
          await participant.request.get(
            `${f.origin}/api/vote/${f.link.id}/answers/${f.question.id}`,
          )
        ).json()
      ).answer,
    ).toBeNull();
    await participant
      .getByRole('button', {name: 'Optional question', exact: true})
      .click();
    await expect(
      current.getByText('Optional question', {exact: true}),
    ).toBeVisible();
  } finally {
    await device.close();
  }
});

test('a question closed during submission rejects the answer and revocation removes the private view', async ({
  page,
  browser,
}) => {
  const f = await votingFixture(page);
  const device = await browser.newContext();
  const participant = await device.newPage();
  try {
    await participant.goto(f.url);
    const current = participant.getByRole('region', {
      name: 'Текущий вопрос',
      exact: true,
    });
    await current.getByRole('radio', {name: 'Yes', exact: true}).check();
    await participant.route(
      `**/api/vote/${f.link.id}/answers/${f.question.id}`,
      async (route) => {
        if (route.request().method() === 'POST') {
          const closed = await page.request.post(
            `/api/rooms/${f.room.id}/questions/${f.question.id}/lifecycle`,
            {
              headers: {Origin: f.origin},
              data: {action: 'close', revision: f.question.revision},
            },
          );
          expect(closed.status()).toBe(200);
        }
        await route.continue();
      },
    );
    await current
      .getByRole('button', {name: 'Отправить ответ', exact: true})
      .click();
    await expect(
      participant.getByText('Вопрос закрыт, ответ не принят', {exact: true}),
    ).toBeVisible();
    await expect(
      participant.getByRole('heading', {name: 'Ожидание вопросов'}),
    ).toBeVisible();
    expect(
      (
        await (
          await participant.request.get(
            `${f.origin}/api/vote/${f.link.id}/answers/${f.question.id}`,
          )
        ).json()
      ).answer,
    ).toBeNull();
    expect(
      (
        await page.request.patch(`/api/rooms/${f.room.id}/links/${f.link.id}`, {
          headers: {Origin: f.origin},
          data: {action: 'revoke'},
        })
      ).status(),
    ).toBe(200);
    await expect(
      participant.getByRole('heading', {name: 'Ссылка недействительна'}),
    ).toBeVisible({timeout: 10000});
    await expect(current).toHaveCount(0);
  } finally {
    await device.close();
  }
});

test('multiple answers validate bounds and show a fixed own answer after saving', async ({
  page,
  browser,
}) => {
  const f = await votingFixture(page, {
    choiceMode: 'multiple',
    minChoices: 2,
    maxChoices: 2,
    choices: [{content: 'Yes'}, {content: 'No'}, {content: 'Maybe'}],
  });
  const device = await browser.newContext();
  const participant = await device.newPage();
  try {
    await participant.goto(f.url);
    const current = participant.getByRole('region', {
      name: 'Текущий вопрос',
      exact: true,
    });
    await current
      .getByRole('button', {name: 'Отправить ответ', exact: true})
      .click();
    await expect(current.getByRole('alert')).toContainText(
      'Выберите от 2 до 2 вариантов',
    );
    await current.getByRole('checkbox', {name: 'Yes', exact: true}).check();
    await current.getByRole('checkbox', {name: 'Maybe', exact: true}).check();
    await current
      .getByRole('button', {name: 'Отправить ответ', exact: true})
      .click();
    await expect(
      participant.getByRole('heading', {name: 'Ожидание вопросов'}),
    ).toBeVisible();
    await participant
      .getByRole('tab', {name: 'Мои ответы', exact: true})
      .click();
    await participant
      .getByRole('button', {name: 'Choose a result', exact: true})
      .click();
    await expect(
      current.getByRole('checkbox', {name: 'Yes', exact: true}),
    ).toBeChecked();
    await expect(
      current.getByRole('checkbox', {name: 'Maybe', exact: true}),
    ).toBeChecked();
    await expect(
      current.getByRole('checkbox', {name: 'No', exact: true}),
    ).toBeDisabled();
    await expect(
      current.getByRole('button', {name: 'Изменить ответ'}),
    ).toHaveCount(0);
  } finally {
    await device.close();
  }
});
