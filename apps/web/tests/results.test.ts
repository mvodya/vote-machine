import {expect, it} from 'vitest';
import {publicResult, resultCsv} from '../lib/results';
import {isAnswer, publicAnswer} from '../lib/ballots';
const id = 'a96c3a49-0198-4545-8dce-44b70c86494d';
const result = {
  id,
  roomId: id,
  available: true,
  content: 'Q',
  state: 'closed',
  anonymous: true,
  choiceMode: 'multiple',
  total: 1,
  options: [{id, content: '=HYPERLINK("bad")', count: 1, percent: 100}],
  sources: {personal: 1, admin_personal: 0, reusable: 0, admin_manual: 0},
  people: [{secret: 'never'}],
  nextPeopleCursor: id,
};
it('drops identities even if the upstream anonymous result contains them', () => {
  const value = publicResult(result, true)!;
  expect(value.people).toBeUndefined();
  expect(value.nextPeopleCursor).toBeUndefined();
  const participant = publicResult(result, false)!;
  expect(participant.sources).toBeUndefined();
  expect(participant.people).toBeUndefined();
});
it('drops all numbers from a hidden result and refuses its export', () => {
  const value = publicResult({...result, available: false}, true)!;
  expect(value).toEqual({id, available: false});
  expect(resultCsv(value)).toBeNull();
});
it('rejects impossible counts and protects formula text in CSV', () => {
  expect(publicResult({...result, total: 0}, true)).toBeNull();
  const csv = resultCsv(publicResult(result, true)!);
  expect(csv).toContain(`"'=HYPERLINK(""bad"")"`);
  expect(csv).not.toContain('personal');
  expect(csv).not.toContain(id);
});
it('accepts only a minimal hidden own answer with no choice or timestamp', () => {
  const hidden = {questionId: id, revision: '2', choices: [], hidden: true};
  expect(isAnswer(hidden)).toBe(true);
  expect(publicAnswer(hidden)).toEqual(hidden);
  expect(isAnswer({...hidden, id})).toBe(false);
  expect(isAnswer({...hidden, choices: [id]})).toBe(false);
});
it('merges manual personal entry into the regular personal source', () => {
  const value = publicResult(
    {
      ...result,
      total: 3,
      sources: {personal: 1, admin_personal: 2, reusable: 0, admin_manual: 0},
    },
    true,
  )!;
  expect(value.sources?.personal).toBe(3);
  expect(value.sources).not.toHaveProperty('admin_personal');
});
it('uses a minimal projector projection even if the upstream includes identities', () => {
  const value = publicResult({...result, anonymous: false}, true, true)!;
  expect(value.people).toBeUndefined();
  expect(value.sources).toBeUndefined();
});

it('keeps empty submitted answers in admin results for old and new readers', () => {
  for (const choices of [null, []]) {
    const value = publicResult(
      {
        ...result,
        anonymous: false,
        people: [
          {
            id,
            linkId: id,
            name: 'Empty answer',
            source: 'personal',
            choices,
          },
        ],
        nextPeopleCursor: null,
      },
      true,
    );
    expect(value?.total).toBe(1);
    expect(value?.people?.[0].choices).toEqual([]);
  }
  expect(
    publicResult(
      {
        ...result,
        anonymous: false,
        people: [
          {
            id,
            linkId: id,
            name: null,
            source: 'personal',
            choices: 'invalid',
          },
        ],
        nextPeopleCursor: null,
      },
      true,
    ),
  ).toBeNull();
});

it('translates CSV headers without changing user option text', () => {
  const csv = resultCsv(
    {
      ...publicResult(result, false)!,
      options: [{id, content: 'Ответы', count: 1, percent: 100}],
    },
    'en',
  )!;
  expect(csv).toContain('"Option","Votes","Percentage"');
  expect(csv).toContain('"Ответы","1","100"');
});

it('keeps registration sources separate and reads older result payloads', () => {
  const value = publicResult(
    {
      ...result,
      sources: {personal: 0, reusable: 0, registration: 1, admin_manual: 0},
    },
    true,
  )!;
  expect(value.sources).toEqual({
    personal: 0,
    reusable: 0,
    registration: 1,
    admin_manual: 0,
  });
  expect(publicResult(result, true)!.sources?.registration).toBe(0);
});
