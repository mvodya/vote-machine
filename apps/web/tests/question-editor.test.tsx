import {render, screen} from '@testing-library/react';
import {expect, it, vi} from 'vitest';
import {QuestionEditor} from '../app/rooms/[id]/question-editor';
import {emptyQuestion, type Question} from '../lib/questions';

const room = 'a96c3a49-0198-4545-8dce-44b70c86494d';
// Read-only behavior does not need a fake database or HTTP server
function show(editLocked: boolean | null) {
  const question: Question = {
    ...emptyQuestion(),
    id: 'a96c3a49-0198-4545-8dce-44b70c86494e',
    roomId: room,
    preview: '',
    state: editLocked === null ? 'draft' : 'open',
    editLocked,
    ordinal: '1',
    revision: '1',
    createdAt: '2026-10-25T00:00:00.000000Z',
    choiceCount: 0,
    choices: [],
  };
  render(
    <QuestionEditor
      roomId={room}
      question={question}
      onSaved={vi.fn()}
      onDenied={vi.fn()}
      onClose={vi.fn()}
      onReload={vi.fn()}
    />,
  );
}
it('shows a small edit notice only for a locked question', () => {
  show(true);
  expect(
    screen.getByText(
      'Администратор не может редактировать содержимое этого вопроса',
    ),
  ).toHaveClass('text-xs', 'text-muted');
  expect(
    screen.getByRole('region', {name: 'Предпросмотр: Текст вопроса'}),
  ).toBeVisible();
  expect(
    screen.queryByRole('button', {name: 'Сохранить изменения'}),
  ).not.toBeInTheDocument();
});
it.each([false, null])(
  'keeps editable questions free of a lock notice: %s',
  (locked) => {
    show(locked);
    expect(
      screen.queryByText(
        'Администратор не может редактировать содержимое этого вопроса',
      ),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText('Текст вопроса')).toBeEnabled();
  },
);
