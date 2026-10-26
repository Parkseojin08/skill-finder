import { useKorean } from '../translate.ts';

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
      <p className={className} lang="ko">
        {ko}
      </p>
      <details className="original">
        <summary>원문 (영어)</summary>
        <p lang="en">{text}</p>
      </details>
    </div>
  );
}
