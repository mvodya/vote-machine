import {expect, test} from '@playwright/test';
import {votingFixture} from './voting-helpers';
// Verify the actual styles on the participant page, not just class names
test('the question timer blinks quickly and the hourglass pauses upright', async ({
  page,
  browser,
}) => {
  const f = await votingFixture(page);
  const response = await page.request.post(
    `/api/rooms/${f.room.id}/questions/${f.question.id}/lifecycle`,
    {
      headers: {Origin: f.origin},
      data: {
        action: 'settings',
        revision: f.question.revision,
        closesAt: new Date(Date.now() + 10000).toISOString(),
        shareResults: false,
        publication: 'after_close',
      },
    },
  );
  expect(response.status()).toBe(200);
  const context = await browser.newContext({reducedMotion: 'no-preference'});
  try {
    const guest = await context.newPage();
    await guest.goto(f.url);
    const timer = guest
      .getByRole('region', {name: 'Текущий вопрос', exact: true})
      .getByRole('timer');
    await expect(timer).toHaveClass(/animate-deadline-blink/);
    expect(
      await timer.evaluate(
        (element) => getComputedStyle(element).animationDuration,
      ),
    ).toBe('0.6s');
    const frames = await timer
      .locator('svg')
      .evaluate((element) =>
        (element.getAnimations()[0].effect as KeyframeEffect).getKeyframes(),
      );
    expect(frames.length).toBeGreaterThanOrEqual(5);
    expect(frames[0].transform).toBe(frames[1].transform);
    expect(frames[2].transform).toBe(frames[3].transform);
    expect(frames[0].transform).not.toBe(frames[2].transform);
    await guest.emulateMedia({reducedMotion: 'reduce'});
    expect(
      await timer.evaluate(
        (element) => getComputedStyle(element).animationName,
      ),
    ).toBe('none');
    expect(
      await timer
        .locator('svg')
        .evaluate((element) => getComputedStyle(element).animationName),
    ).toBe('none');
  } finally {
    await context.close();
  }
});
