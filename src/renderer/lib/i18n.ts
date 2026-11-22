import type { Lang } from '@shared/types';

let lang: Lang = 'pl';

export function setLang(l: Lang) {
  lang = l;
  document.documentElement.lang = l;
}

export function getLang(): Lang {
  return lang;
}

/** Inline bilingual string: tx('Zapisz', 'Save'). */
export function tx(pl: string, en: string): string {
  return lang === 'pl' ? pl : en;
}
