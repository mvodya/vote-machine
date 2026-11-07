import {describe, expect, it} from 'vitest';
import {emptyQuestion, isQuestionInput, questionInput} from '../lib/questions';

// New answer kinds must not loosen validation for existing questions
describe('question kinds', () => {
  it('keeps ordinary choice drafts valid and rejects unknown kinds', () => {
    expect(isQuestionInput(emptyQuestion())).toBe(true);
    expect(isQuestionInput({...emptyQuestion(), questionType: 'script'})).toBe(
      false,
    );
  });
  it('accepts bounded capacities and rejects missing, zero, fractional and huge limits', () => {
    const make = (capacity: unknown) => ({
      ...emptyQuestion(),
      questionType: 'allocation',
      choices: [{content: 'Slot', capacity}],
    });
    expect(isQuestionInput(make(1))).toBe(true);
    expect(isQuestionInput(make(1000000))).toBe(true);
    for (const capacity of [undefined, null, 0, -1, 1.5, '2', 1000001])
      expect(isQuestionInput(make(capacity))).toBe(false);
  });
  it('never forwards live occupancy as an editor setting', () => {
    const value = {
      ...emptyQuestion(),
      questionType: 'allocation' as const,
      choices: [{content: 'A', capacity: 4, remaining: 2}],
    };
    expect(isQuestionInput(value)).toBe(true);
    expect(questionInput(value).choices).toEqual([{content: 'A', capacity: 4}]);
    expect(
      isQuestionInput({
        ...value,
        choices: [{content: 'A', capacity: 4, remaining: 5}],
      }),
    ).toBe(false);
  });
  it('keeps visibility specific to allocation and rejects non-boolean settings', () => {
    const value = {
      ...emptyQuestion(),
      questionType: 'allocation' as const,
      choices: [{content: 'A', capacity: 1}],
    };
    expect(questionInput(value).hideUnavailable).toBe(true);
    expect(
      questionInput({...value, hideUnavailable: false}).hideUnavailable,
    ).toBe(false);
    expect(isQuestionInput({...value, hideUnavailable: 'false'})).toBe(false);
    expect(
      questionInput({...emptyQuestion(), hideUnavailable: false}),
    ).not.toHaveProperty('hideUnavailable');
  });
});
