import { TRANSLATE_TO, useKorean } from '../translate.ts';
import { t } from '../i18n.ts';

/** English text shown in Korean when the browser can translate it, with the original one click away. */
export function Translated({ text, className }: { text: string; className?: string }) {
  const { ko } = useKorean(text);
  if (!ko) {
    return (
      <p className={className} lang="en">
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
