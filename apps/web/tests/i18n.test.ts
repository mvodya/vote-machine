import {expect, it} from 'vitest';
import ru from '../lib/i18n/messages/ru.json';
import en from '../lib/i18n/messages/en.json';
import {
  isLocale,
  localeFromRequest,
  preferredLocale,
  translate,
} from '../lib/i18n/translate';

it('keeps complete catalogs and the same placeholders in both languages', () => {
  expect(Object.keys(en).sort()).toEqual(Object.keys(ru).sort());
  for (const key of Object.keys(ru) as (keyof typeof ru)[]) {
    expect(en[key].trim()).not.toBe('');
    expect((en[key].match(/\{\w+\}/g) ?? []).sort()).toEqual(
      (ru[key].match(/\{\w+\}/g) ?? []).sort(),
    );
    expect(en[key]).not.toMatch(/[А-Яа-я]/);
  }
});
it('uses browser preferences and accepts only registered language cookies', () => {
  expect(preferredLocale('fr, ru-RU;q=0.9,en;q=0.8')).toBe('ru');
  expect(preferredLocale('en-US,ru;q=0.8')).toBe('en');
  expect(preferredLocale('ru;q=0,en;q=0.5')).toBe('en');
  expect(preferredLocale('de,ru;q=broken')).toBe('en');
  expect(isLocale('__proto__')).toBe(false);
  expect(
    localeFromRequest(
      new Request('https://vote.test', {
        headers: {cookie: 'other=1; vm-language=ru', 'accept-language': 'en'},
      }),
    ),
  ).toBe('ru');
  expect(
    localeFromRequest(
      new Request('https://vote.test', {
        headers: {cookie: 'vm-language=../secrets', 'accept-language': 'en'},
      }),
    ),
  ).toBe('en');
});
it('keeps supplied names and placeholder-like values unchanged', () => {
  const name = 'Настройки <img src=x> {value1}';
  expect(translate('en', 'Удалить вопрос: {value0}', {value0: name})).toBe(
    `Delete question: ${name}`,
  );
  expect(translate('ru', 'Незнакомый текст')).toBe('Незнакомый текст');
  expect(translate('en', 'Неизвестная ошибка')).toBe('Неизвестная ошибка');
});
