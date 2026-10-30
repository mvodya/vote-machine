import ru from './messages/ru.json';
import en from './messages/en.json';

// Add a catalog and one entry here to make another language available
export const languages = {
  ru: {name: 'Русский', flag: '🇷🇺', tag: 'ru-RU', messages: ru},
  en: {name: 'English', flag: '🇬🇧', tag: 'en-GB', messages: en},
};
export type Locale = keyof typeof languages;
export const locales = Object.keys(languages) as Locale[];
export type Values = Record<string, string | number>;
export type Translator = (message: string, values?: Values) => string;
export const languageCookie = 'vm-language';
export const localeTags = Object.fromEntries(
  locales.map((locale) => [locale, languages[locale].tag]),
) as Record<Locale, string>;
// Ignore unknown cookie values instead of using them as file names
export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && Object.hasOwn(languages, value);
}

// Keep names and values outside translation lookup and HTML parsing
export function translate(
  locale: Locale,
  message: string,
  values: Values = {},
) {
  const catalog: Record<string, string> = languages[locale].messages;
  const text = Object.hasOwn(catalog, message) ? catalog[message] : message;
  return text.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (match, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : match,
  );
}

// Match browser languages by preference and fall back to English
export function preferredLocale(header: string): Locale {
  const preferences = header
    .split(',')
    .map((part, index) => {
      const [tag, ...options] = part.trim().split(';');
      const quality = options.find((option) => option.trim().startsWith('q='));
      return {
        tag: tag.toLowerCase().split('-')[0],
        quality: quality ? Number(quality.trim().slice(2)) : 1,
        index,
      };
    })
    .filter(
      (item) =>
        Number.isFinite(item.quality) && item.quality > 0 && item.quality <= 1,
    )
    .sort((a, b) => b.quality - a.quality || a.index - b.index);
  return (
    (preferences.find((item) => isLocale(item.tag))?.tag as
      | Locale
      | undefined) ?? 'en'
  );
}

// Use the same preference for downloads and the initial page
export function localeFromRequest(request: Request): Locale {
  const saved = (request.headers.get('cookie') ?? '')
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(languageCookie + '='))
    ?.slice(languageCookie.length + 1);
  return isLocale(saved)
    ? saved
    : preferredLocale(request.headers.get('accept-language') ?? '');
}
