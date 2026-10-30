import {cookies, headers} from 'next/headers';
import {isLocale, languageCookie, preferredLocale} from './translate';

// Render the saved language on the server without a first-paint switch
export async function requestLocale() {
  const saved = (await cookies()).get(languageCookie)?.value;
  return isLocale(saved)
    ? saved
    : preferredLocale((await headers()).get('accept-language') ?? '');
}
