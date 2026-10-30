'use client';
import {
  ChartColumn,
  ListChecks,
  MessageSquare,
  Settings,
  Users,
} from 'lucide-react';
import {useI18n} from './language-provider';
import {Tabs} from './ui/tabs';

// Keep room navigation identical in the application and product page
export function RoomTabs({
  group,
  value,
  onChange,
  includeSettings = true,
  contained = false,
}: {
  // IDs stay unique when several workspaces share one page
  group: string;
  value: string;
  onChange: (value: string) => void;
  // The product page presents the three main work areas
  includeSettings?: boolean;
  // Use the frame width only for scaled device views
  contained?: boolean;
}) {
  const {t} = useI18n();
  return (
    <Tabs
      contained={contained}
      label={t('Разделы комнаты')}
      group={group}
      value={value}
      onChange={onChange}
      items={[
        {id: 'questions', label: t('Вопросы'), icon: <ListChecks size={18} />},
        {id: 'respondents', label: t('Респонденты'), icon: <Users size={18} />},
        {
          id: 'results',
          label: t('Результаты'),
          icon: <ChartColumn size={18} />,
        },
        ...(includeSettings
          ? [
              {
                id: 'settings',
                label: t('Настройки'),
                icon: <Settings size={18} />,
              },
            ]
          : []),
      ]}
    />
  );
}

// Share participant tab names and icons with every ballot view
export function ParticipantTabs({
  group,
  value,
  onChange,
  resultsAvailable,
  contained = false,
}: {
  group: string;
  value: string;
  onChange: (value: string) => void;
  resultsAvailable: boolean;
  // Use the frame width only for scaled device views
  contained?: boolean;
}) {
  const {t} = useI18n();
  return (
    <Tabs
      contained={contained}
      label={t('Вкладки участника')}
      group={group}
      value={value}
      onChange={onChange}
      items={[
        {id: 'question', label: t('Вопрос'), icon: <MessageSquare />},
        {id: 'list', label: t('Список вопросов'), icon: <ListChecks />},
        ...(resultsAvailable
          ? [{id: 'results', label: t('Результаты'), icon: <ChartColumn />}]
          : []),
      ]}
    />
  );
}
