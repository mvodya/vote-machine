'use client';
import {useI18n} from './language-provider';
import {useEffect, useState} from 'react';

const phrases = [
  'Система организации голосований',
  'Проведение опросов',
  'Быстрая организация голосования без регистрации',
  'Голосование в реальном времени',
  'Голосования для диссертационных советов',
  'Персональные ссылки для участников',
  'Общие ссылки для опросов',
  'Опросы с одним вариантом ответа',
  'Выбор нескольких вариантов ответа',
  'Вопросы с изображениями и видео',
  'Результаты голосования в реальном времени',
  'Автоматическое закрытие вопросов',
  'Отложенный запуск голосования',
  'Голосование с телефона и компьютера',
  'Опросы для встреч и собраний',
  'Анонимные и открытые голосования',
  'Настройка публикации результатов',
  'История ответов участников',
  'Показ результатов на общем экране',
];

// Reserve space so typing and line breaks never move the form
export function HomeCaption() {
  const {t} = useI18n();
  const [text, setText] = useState('');
  useEffect(() => {
    const localized = phrases.map((phrase) => t(phrase));
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    let timer: ReturnType<typeof setTimeout>;
    let index = 0;
    let length = 0;
    let deleting = false;

    // Pick another factual phrase after erasing the current one
    function tick() {
      if (document.hidden) return;
      if (motion.matches) {
        setText(localized[0]);
        return;
      }
      length += deleting ? -1 : 1;
      setText(localized[index].slice(0, length));
      let delay = deleting ? 25 : 55;
      if (length === localized[index].length && !deleting) {
        deleting = true;
        delay = 5000;
      } else if (length === 0 && deleting) {
        index =
          (index + 1 + Math.floor(Math.random() * (phrases.length - 1))) %
          phrases.length;
        deleting = false;
        delay = 350;
      }
      timer = setTimeout(tick, delay);
    }

    // Restart with a clean line after a preference or visibility change
    function start() {
      clearTimeout(timer);
      length = 0;
      deleting = false;
      if (document.hidden) return;
      if (motion.matches) setText(localized[0]);
      else {
        setText('');
        timer = setTimeout(tick, 400);
      }
    }
    start();
    motion.addEventListener('change', start);
    document.addEventListener('visibilitychange', start);
    return () => {
      clearTimeout(timer);
      motion.removeEventListener('change', start);
      document.removeEventListener('visibilitychange', start);
    };
  }, [t]);
  return (
    <div data-home-caption aria-hidden="true" className="relative h-32">
      <p className="max-w-[24rem] text-lg leading-relaxed font-medium text-muted lg:text-2xl">
        <span>{text}</span>
        <span className="ml-1 inline-block h-[1em] w-px translate-y-0.5 bg-primary/60 motion-safe:animate-pulse motion-reduce:hidden" />
      </p>
    </div>
  );
}
