'use client';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  isLocale,
  languageCookie,
  localeTags,
  translate,
  type Locale,
  type Values,
} from '../lib/i18n/translate';

// Keep isolated component tests and standalone renders in Russian
const fallback = {
  locale: 'ru' as Locale,
  localeTag: localeTags.ru,
  t: (message: string, values?: Values) => translate('ru', message, values),
  setLocale: (_locale: Locale) => {
    void _locale;
  },
};
const Context = createContext(fallback);

// Change labels without remounting forms or discarding unsaved edits
export function LanguageProvider({
  initialLocale,
  children,
}: {
  initialLocale: Locale;
  children: ReactNode;
}) {
  const [locale, updateLocale] = useState(initialLocale);
  const setLocale = useCallback((next: Locale) => {
    if (!isLocale(next)) return;
    updateLocale(next);
    document.documentElement.lang = next;
    document.cookie = `${languageCookie}=${next}; Path=/; Max-Age=34560000; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
    try {
      localStorage.setItem(languageCookie, next);
    } catch {}
  }, []);
  useEffect(() => {
    // Other open tabs follow the same saved preference
    function sync(event: StorageEvent) {
      if (event.key === languageCookie && isLocale(event.newValue))
        setLocale(event.newValue);
    }
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, [setLocale]);
  const t = useCallback(
    (message: string, values?: Values) => translate(locale, message, values),
    [locale],
  );
  const value = useMemo(
    () => ({locale, localeTag: localeTags[locale], t, setLocale}),
    [locale, t, setLocale],
  );
  return <Context value={value}>{children}</Context>;
}

// Read the current language and its message formatter
export function useI18n() {
  return useContext(Context);
}
