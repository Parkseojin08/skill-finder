import { TRANSLATE_TO, useKorean } from '../translate.ts';
import { t } from '../i18n.ts';
import { worthTranslating } from '../lib/textLang.ts';

/** English text shown in Korean when the browser can translate it, with the original one click away. */
export function Translated({ text, className }: { text: string; className?: string }) {
  const { ko } = useKorean(text);
  if (!ko) {
    return (
      // only English is marked as such: a README intro may already be in Korean
      <p className={className} lang={worthTranslating(text) ? 'en' : undefined}>
        {text}
      </p>
    );
  }
  return (
    <div className="translated">
      <p className={className} lang={TRANSLATE_TO ?? 'en'}>
        {ko}
      </p>
      <details className="original">
        <summary>{t('원문 (영어)')}</summary>
        <p lang="en">{text}</p>
      </details>
    </div>
  );
}
