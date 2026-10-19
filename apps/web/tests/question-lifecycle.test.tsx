import {fireEvent, render, screen, waitFor} from '@testing-library/react';
import {expect, it, vi} from 'vitest';
import {QuestionEditor} from '../app/rooms/[id]/question-editor';
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
  closesAt: '2027-01-01T00:00:30.123Z',
  deadlineMode: 'absolute',
  choiceCount: 2,
  choices: [
    {id: option, content: 'Yes'},
    {id, content: 'No'},
  ],
};
it('preserves the exact deadline when saving settings from another tab', async () => {
  const fetcher = vi.fn().mockResolvedValue(
    Response.json({
      question: {...question, shareResults: true, revision: '2'},
    }),
  );
  vi.stubGlobal('fetch', fetcher);
  const saved = vi.fn();
  render(
    <QuestionEditor
      roomId={id}
      question={question}
      timeZone="Asia/Vladivostok"
      onSaved={saved}
      onClose={vi.fn()}
      onDenied={vi.fn()}
      onReload={vi.fn()}
    />,
  );
  expect(
    screen.queryByRole('button', {name: 'Сохранить изменения'}),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', {name: 'Настройки'}));
  fireEvent.click(screen.getByLabelText('Публиковать результаты участникам'));
  fireEvent.click(screen.getByRole('tab', {name: 'Управление'}));
  expect(screen.getByLabelText('Время закрытия')).toHaveValue('10:00:30');
  fireEvent.click(screen.getByRole('button', {name: 'Сохранить изменения'}));
  await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
  const body = JSON.parse(fetcher.mock.calls[0][1].body);
  expect(body.closesAt).toBe(question.closesAt);
  expect(body.shareResults).toBe(true);
  expect(body.state).toBe('open');
  expect(
    screen.queryByRole('button', {name: 'Сохранить изменения'}),
  ).not.toBeInTheDocument();
  expect(screen.getByRole('button', {name: 'Вернуться'})).toBeVisible();
});
it('saves settings and closes immediately from the management action', async () => {
  const fetcher = vi.fn().mockResolvedValue(
    Response.json({
      question: {
        ...question,
        state: 'closed',
        shareResults: true,
        revision: '2',
      },
    }),
  );
  vi.stubGlobal('fetch', fetcher);
  const saved = vi.fn();
  render(
    <QuestionEditor
      roomId={id}
      question={question}
      timeZone="UTC"
      onSaved={saved}
      onClose={vi.fn()}
      onDenied={vi.fn()}
      onReload={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole('tab', {name: 'Настройки'}));
  fireEvent.click(screen.getByLabelText('Публиковать результаты участникам'));
  fireEvent.click(screen.getByRole('tab', {name: 'Управление'}));
  fireEvent.click(screen.getByRole('button', {name: 'Закрыть вопрос'}));
  await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
  const body = JSON.parse(fetcher.mock.calls[0][1].body);
  expect(body.state).toBe('closed');
  expect(body.shareResults).toBe(true);
  expect(
    screen.queryByRole('button', {name: 'Сохранить изменения'}),
  ).not.toBeInTheDocument();
});
