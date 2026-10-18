import {expect, type Page} from '@playwright/test';

// Create real admin and personal access without sharing cookies between roles
export async function votingFixture(
  page: Page,
  extra: Record<string, unknown> = {},
) {
  await page.goto('/');
  const origin = new URL(page.url()).origin;
  const created = await page.request.post('/api/rooms', {
    headers: {Origin: origin},
    data: {name: 'Voting browser'},
  });
  expect(created.status()).toBe(201);
  const {room, adminToken} = await created.json();
  expect(
    (
      await page.request.post(`/api/rooms/${room.id}/session`, {
        headers: {Origin: origin},
        data: {token: adminToken},
      })
    ).status(),
  ).toBe(200);
  const response = await page.request.post(`/api/rooms/${room.id}/questions`, {
    headers: {Origin: origin},
    data: {
      content: 'Choose a result',
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
  expect(response.status()).toBe(201);
  const {question: draft} = await response.json();
  const opened = await page.request.post(
    `/api/rooms/${room.id}/questions/${draft.id}/lifecycle`,
    {
      headers: {Origin: origin},
      data: {action: 'open', revision: draft.revision},
    },
  );
  expect(opened.status()).toBe(200);
  const {question} = await opened.json();
  const links = await page.request.post(`/api/rooms/${room.id}/links`, {
    headers: {Origin: origin},
    data: {mode: 'personal', names: ['Alice']},
  });
  expect(links.status()).toBe(201);
  const {
    links: [link],
  } = await links.json();
  const {token} = await (
    await page.request.get(`/api/rooms/${room.id}/links/${link.id}/secret`)
  ).json();
  return {
    origin,
    room,
    question,
    link,
    url: `${origin}/vote/${link.id}#key=${token}`,
  };
}
