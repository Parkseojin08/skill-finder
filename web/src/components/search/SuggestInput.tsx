import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { apiGet } from '../../api.ts';
import { formatCount } from '../../labels.ts';
import type { Suggestion } from '../../lib/searchExtras.ts';
import { t } from '../../i18n.ts';
import './search-stage2.css';

/** Asked from this many characters (one letter matches a third of the index). */
const MIN_CHARS = 2;
const DEBOUNCE_MS = 120;

const KIND_LABEL: Record<Suggestion['kind'], string> = { skill: t('스킬'), plugin: t('플러그인'), repo: t('저장소'), owner: t('만든 곳') };

/**
 * The search box with name suggestions (F16): skill names, plugins, `owner/repo` and owners from the local index,
 * as the ARIA 1.2 combobox pattern (written out rather than shadcn's Combobox: Enter without a highlighted item
 * must still submit the form, ↓ without a list still moves to the first result card, and Korean input must not be
 * touched mid-composition). ↓/↑ move, Enter picks, Esc closes. While a Hangul syllable is being composed the list
 * stays as it is; it is asked again when the composition ends. Typing never changes the query by itself: only a
 * pick does (user decision E).
 */
export function SuggestInput({
  value,
  onChange,
  onPick,
  onKeyDown,
  inputRef,
  placeholder,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  onPick: (s: Suggestion) => void;
  /** The box's own keys (Esc stops a search, ↓ goes to the results) when the list does not take them. */
  onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
  inputRef: RefObject<HTMLInputElement | null>;
  placeholder: string;
  ariaLabel: string;
}) {
  const listId = useId();
  const [items, setItems] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const composing = useRef(false);
  const asked = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const close = () => {
    setOpen(false);
    setActive(-1);
  };
  /** Asks for what is typed now; a slower earlier answer never replaces a later one. */
  const ask = (text: string) => {
    clearTimeout(timer.current);
    const q = text.trim();
    if (q.length < MIN_CHARS) {
      asked.current++;
      setItems([]);
      close();
      return;
    }
    timer.current = setTimeout(() => {
      const n = ++asked.current;
      apiGet<{ items: Suggestion[] }>('/suggest', { q })
        .then((r) => {
          if (n !== asked.current || composing.current) return;
          setItems(r.items);
          setActive(-1);
          setOpen(r.items.length > 0 && document.activeElement === inputRef.current);
        })
        .catch(() => {
          if (n === asked.current) close();
        });
    }, DEBOUNCE_MS);
  };
  const pick = (s: Suggestion) => {
    asked.current++;
    clearTimeout(timer.current);
    close();
    onPick(s);
  };

  const keyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // the IME has the keys while composing (Enter there commits the syllable, not a pick or a search)
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const shown = open && items.length > 0;
    if (e.key === 'ArrowDown' && (shown || (items.length > 0 && value.trim().length >= MIN_CHARS && !open))) {
      e.preventDefault();
      setOpen(true);
      setActive((i) => (shown ? (i + 1) % items.length : 0));
      return;
    }
    if (e.key === 'ArrowUp' && shown) {
      e.preventDefault();
      setActive((i) => (i <= 0 ? -1 : i - 1));
      return;
    }
    if (e.key === 'Enter' && shown && active >= 0) {
      e.preventDefault();
      pick(items[active]);
      return;
    }
    if (e.key === 'Escape' && shown) {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      // a search of what is typed (the form submits): the list goes, and an answer still on its way is dropped
      asked.current++;
      clearTimeout(timer.current);
      close();
    }
    onKeyDown(e);
  };

  const shown = open && items.length > 0;
  return (
    <div className="suggest-wrap">
      <input
        ref={inputRef}
        value={value}
        role="combobox"
        aria-expanded={shown}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={shown && active >= 0 ? `${listId}-${active}` : undefined}
        onChange={(e) => {
          onChange(e.target.value);
          if (!composing.current) ask(e.target.value);
        }}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={(e) => {
          composing.current = false;
          ask(e.currentTarget.value);
        }}
        onKeyDown={keyDown}
        onBlur={close}
        placeholder={placeholder}
        maxLength={300}
        aria-label={ariaLabel}
        autoFocus
        autoComplete="off"
        spellCheck={false}
      />
      <ul id={listId} role="listbox" className="suggest-list" hidden={!shown} aria-label={t('검색어 제안')}>
        {items.map((s, i) => (
          <li
            key={`${s.kind}:${s.text}`}
            id={`${listId}-${i}`}
            role="option"
            aria-selected={i === active}
            className={i === active ? 'active' : undefined}
            // mousedown would blur the box (and close the list) before the click lands
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => setActive(i)}
            onClick={() => pick(s)}
          >
            <span className="suggest-kind">{KIND_LABEL[s.kind]}</span>
            <span className="suggest-text mono">{s.text}</span>
            <span className="suggest-meta muted small">
              {s.stars != null && `★${formatCount(s.stars)}`}
              {s.kind !== 'skill' && ` · ${t('스킬 {0}개', s.count)}`}
              {s.kind === 'skill' && s.count > 1 && ` · ${t('같은 이름 {0}곳', s.count)}`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
