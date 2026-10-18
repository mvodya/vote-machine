import {randomUUID} from 'node:crypto';
import {expect, test} from '@playwright/test';
import {votingFixture} from './voting-helpers';

test('personal browser cookies submit one idempotent ballot and retain the right after close', async ({
  page,
  browser,
}) => {
  const f = await votingFixture(page);
  const device = await browser.newContext();
  const participant = await device.newPage();
  try {
    await participant.goto(f.url);
    await expect(
      participant.getByRole('heading', {name: 'Voting browser', exact: true}),
    ).toBeVisible();
    const path = `${f.origin}/api/vote/${f.link.id}/answers/${f.question.id}`;
    const input = {
      requestId: randomUUID(),
      questionRevision: f.question.revision,
      ballotRevision: '0',
      choices: [f.question.choices[0].id],
    };
    expect(
      (
        await page.request.post(path, {
          headers: {Origin: f.origin},
          data: input,
        })
      ).status(),
    ).toBe(401);
    expect(
      (
        await participant.request.post(path, {
          headers: {Origin: 'https://foreign.test'},
          data: input,
        })
      ).status(),
    ).toBe(403);
    const first = await participant.request.post(path, {
      headers: {Origin: f.origin},
      data: input,
    });
    expect(first.status()).toBe(200);
    const saved = await first.json();
    expect(saved.answer.choices).toEqual(input.choices);
    expect(saved.answer).not.toHaveProperty('linkId');
    const retry = await participant.request.post(path, {
      headers: {Origin: f.origin},
      data: input,
    });
    expect(await retry.json()).toEqual(saved);
    expect(
      (
        await participant.request.post(path, {
          headers: {Origin: f.origin},
          data: {...input, choices: [f.question.choices[1].id]},
        })
      ).status(),
    ).toBe(409);
    expect(
      (
        await page.request.post(
          `/api/rooms/${f.room.id}/questions/${f.question.id}/lifecycle`,
          {
            headers: {Origin: f.origin},
            data: {action: 'close', revision: f.question.revision},
          },
        )
      ).status(),
    ).toBe(200);
    expect(
      (
        await participant.request.post(path, {
          headers: {Origin: f.origin},
          data: {...input, requestId: randomUUID()},
        })
      ).status(),
    ).toBe(409);
    expect(await (await participant.request.get(path)).json()).toEqual(saved);
    expect(
      await (
        await participant.request.post(path, {
          headers: {Origin: f.origin},
          data: input,
        })
      ).json(),
    ).toEqual(saved);
  } finally {
    await device.close();
  }
});
