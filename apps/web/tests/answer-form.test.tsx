import {fireEvent, render, screen, waitFor} from '@testing-library/react';
import {expect, it, vi} from 'vitest';
import {AnswerForm} from '../app/vote/[id]/answer-form';
import {emptyQuestion, type Question} from '../lib/questions';

const id = 'a96c3a49-0198-4545-8dce-44b70c86494d';
const option = 'b96c3a49-0198-4545-8dce-44b70c86494d';
const question: Question = {
  ...emptyQuestion(),
  id,
  roomId: id,
  preview: 'Q',
  content: 'Q',
  state: 'open',
  editLocked: true,
  ordinal: '1',
  revision: '1',
  createdAt: '2026-10-25T00:00:00Z',
  choiceCount: 2,
  choices: [
    {id: option, content: 'Yes'},
    {id, content: 'No'},
  ],
};
it('retries an unknown result with exactly the same body and waits for confirmation', async () => {
  const saved = vi.fn();
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(new Error('Offline'))
    .mockResolvedValueOnce(
      Response.json({
        answer: {
          id,
          questionId: id,
          revision: '1',
          choices: [option],
          createdAt: '2026-10-25T00:00:00Z',
          updatedAt: '2026-10-25T00:00:00Z',
        },
      }),
    );
  vi.stubGlobal('fetch', fetcher);
  const {container} = render(
    <AnswerForm
      linkId={id}
      question={question}
      answer={null}
      onSaved={saved}
      onRefresh={vi.fn()}
      onDenied={vi.fn()}
      onSkip={vi.fn()}
      onBusy={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole('radio', {name: 'Yes'}));
  fireEvent.submit(container.querySelector('form')!);
  await screen.findByRole('alert');
  expect(saved).not.toHaveBeenCalled();
  fireEvent.submit(container.querySelector('form')!);
  await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
  expect(fetcher.mock.calls[0][1].body).toBe(fetcher.mock.calls[1][1].body);
});
it('does not submit a selection outside the question bounds', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  const {container} = render(
    <AnswerForm
      linkId={id}
      question={question}
      answer={null}
      onSaved={vi.fn()}
      onRefresh={vi.fn()}
      onDenied={vi.fn()}
      onSkip={vi.fn()}
      onBusy={vi.fn()}
    />,
  );
  fireEvent.submit(container.querySelector('form')!);
  expect(screen.getByRole('alert')).toHaveTextContent(
    'Выберите от 1 до 1 вариантов',
  );
  expect(fetcher).not.toHaveBeenCalled();
});

it('sends the selected reusable run and keeps it on a network retry', async () => {
  const fetcher = vi.fn().mockRejectedValue(new Error('Offline'));
  vi.stubGlobal('fetch', fetcher);
  const {container} = render(
    <AnswerForm
      linkId={id}
      question={question}
      answer={null}
      extraPayload={{runId: option}}
      onSaved={vi.fn()}
      onRefresh={vi.fn()}
      onDenied={vi.fn()}
      onSkip={vi.fn()}
      onBusy={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole('radio', {name: 'Yes'}));
  fireEvent.submit(container.querySelector('form')!);
  await screen.findByRole('alert');
  fireEvent.submit(container.querySelector('form')!);
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  expect(JSON.parse(fetcher.mock.calls[0][1].body).runId).toBe(option);
  expect(fetcher.mock.calls[1][1].body).toBe(fetcher.mock.calls[0][1].body);
});
