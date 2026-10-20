// JS `\b` is ASCII-only: it never matches around Cyrillic letters. All word matching goes through `word()`.
const L = "[\\p{L}\\p{N}_]";
export const word = (alts: string): RegExp => new RegExp(`(?<!${L})(?:${alts})(?!${L})`, "iu");

export const GENERALIZER = word(
  "prefers?|always|never|likes|wants|in\\s+general|" +
  "предпочитает|предпочитаем|всегда|никогда|любит|хочет|вообще",
);
export const NEGATION = word("not|never|don'?t|no|without|не|никогда|без|нельзя");
/** "no later than 7 days", "не позднее 7 дней" bound a quantity; they do not negate the sentence. */
export const BOUND_PHRASE = new RegExp(
  `(?<!${L})(?:no\\s+(?:later|earlier|more|less|fewer|greater|longer\\s+than)\\s+than|not\\s+(?:later|earlier|more|less|fewer)\\s+than|` +
  `не\\s+(?:позднее|позже|ранее|раньше|более|менее|больше|меньше|дольше|превышает|превышая))(?!${L})`, "giu");
export const hasNegation = (s: string): boolean => NEGATION.test(s.replace(BOUND_PHRASE, " "));
export const USER_QUOTE = new RegExp(
  `(?<!${L})(?:user\\s*(?:said|says|asked|told|wrote)|directive|` +
  `(?:пользователь|юзер)\\s*(?:сказал|сказала|попросил|попросила|велел|велела|написал|написала)|директива)\\s*[:—-]`,
  "iu",
);
export const USER_PREFIX = /^\s*(?:user|юзер|пользователь)\s*:/iu;
export const ENV_MARKERS = word(
  "returned|response|status\\s*\\d{3}|passed|failed|exit\\s*code|installed|version\\s+[\\d.]+|stack\\s*trace|" +
  "вернул|вернула|вернуло|ответил|статус|упал|упали|упало|прошёл|прошел|прошли|установлен|установлена|версия\\s+[\\d.]+",
);
export const SCOPE_MARKERS = new RegExp(
  `(?<!${L})(?:for\\s+(?:the\\s+)?(?:prototype|poc|mvp|demo|sprint|phase|stage)[^.]*|until\\s+[^.]+|only\\s+(?:for|in|while)\\s+[^.]+|` +
  `для\\s+(?:прототипа|демо|этапа|спринта|фазы)[^.]*|пока\\s+[^.]+|до\\s+(?:миграции|релиза|перехода)[^.]*|только\\s+(?:для|в|на)\\s+[^.]+)`,
  "iu",
);

/** Words that carry stance or evidence, not subject. Excluded when comparing what two records are *about*. */
export const NON_SUBJECT = new Set([
  "the","a","an","to","of","for","in","on","is","are","be","use","using","user","we","it","this","that","and","or","with",
  "said","says","asked","told","wrote","directive","only","until","prototype","prefers","prefer","always","never","likes","wants",
  "not","don't","dont","no","without","general",
  "и","в","на","для","с","по","это","этот","та","то","как","что","юзер","пользователь","мы","используем","использовать",
  "брать","возьми","сказал","сказала","попросил","велел","написал","директива","только","прототипа","пока","до",
  "предпочитает","предпочитаем","всегда","никогда","любит","хочет","вообще","не","без","нельзя",
]);
