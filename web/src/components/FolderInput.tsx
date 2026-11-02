import { FolderOpenIcon, FolderSimpleIcon, UploadSimpleIcon } from '@phosphor-icons/react';
import { useEffect, useId, useRef, useState, type DragEvent } from 'react';
import { createPortal } from 'react-dom';
import { apiSend } from '../api.ts';
import { Button } from '@/components/ui/button';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group';
import { cn } from '@/lib/utils';
import { Icon } from './Icon.tsx';
import { t } from '../i18n.ts';
import { tj } from '../i18nNodes.tsx';

type Match = { path: string; overlap: number };

/** Project folders used before, newest first, offered as suggestions (this browser only; UI debate stage 4). */
const RECENT_KEY = 'skill-finder-recent-projects';
export function recentProjects(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 8) : [];
  } catch {
    return [];
  }
}
export function rememberProject(path: string): void {
  const p = path.trim();
  if (!p) return;
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([p, ...recentProjects().filter((x) => x !== p)].slice(0, 8)));
  } catch {
    // storage blocked: no suggestions, nothing else changes
  }
}

/** Names directly inside a dropped folder (first batch is enough to tell same-named folders apart). */
function readNames(dir: FileSystemDirectoryEntry): Promise<string[]> {
  return new Promise((resolve) => dir.createReader().readEntries((list) => resolve(list.map((e) => e.name).slice(0, 200)), () => resolve([])));
}

/** A dropped path as text: "C:\…", "/home/…", or a file:// URI. */
function pathFromText(text: string): string | null {
  const t = text.trim().split(/\r?\n/)[0] ?? '';
  if (/^file:\/\//i.test(t)) {
    try {
      const p = decodeURIComponent(new URL(t).pathname);
      return /^\/[A-Za-z]:\//.test(p) ? p.slice(1).replace(/\//g, '\\') : p;
    } catch {
      return null;
    }
  }
  return /^[A-Za-z]:[\\/]|^\//.test(t) ? t : null;
}

/**
 * Project folder field: type a path, open the OS folder dialog, or drag a folder onto it.
 * `onChange` fires while typing; `onPick` fires once a folder is chosen (dialog or drop) so callers can act on it.
 * Browsers never reveal a dropped folder's absolute path, so the local server finds it from the folder's name
 * and contents (POST /resolve-folder).
 */
export function FolderInput({
  value,
  onChange,
  onPick,
  placeholder,
  disabled,
  label,
}: {
  value: string;
  onChange: (path: string) => void;
  onPick?: (path: string) => void;
  placeholder?: string;
  disabled?: boolean;
  label?: string;
}) {
  const [picking, setPicking] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [choices, setChoices] = useState<Match[]>([]);
  const [error, setError] = useState<string | null>(null);
  const depth = useRef(0);

  // Keyboard focus must not wander to the page behind the overlay either.
  useEffect(() => {
    const main = document.querySelector('.app');
    if (!picking || !main) return;
    main.setAttribute('inert', '');
    return () => main.removeAttribute('inert');
  }, [picking]);

  const listId = useId();
  const [recent] = useState(recentProjects);
  const choose = (path: string) => {
    rememberProject(path);
    setChoices([]);
    setError(null);
    onChange(path);
    onPick?.(path);
  };

  const pick = async () => {
    setPicking(true);
    setError(null);
    try {
      const r = await apiSend<{ path: string | null }>('POST', '/pick-folder', { initial: value || undefined });
      if (r.path) choose(r.path);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setPicking(false);
    }
  };

  const accepts = (e: DragEvent) => !disabled && [...e.dataTransfer.types].some((t) => t === 'Files' || t === 'text/plain' || t === 'text/uri-list');

  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    depth.current = 0;
    setDragging(false);
    if (disabled) return;
    // Entries must be taken synchronously; the DataTransfer is emptied after this handler returns.
    const entry = [...e.dataTransfer.items].find((i) => i.kind === 'file')?.webkitGetAsEntry() ?? null;
    const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
    setError(null);
    setChoices([]);
    if (!entry) {
      const p = text ? pathFromText(text) : null;
      if (p) choose(p);
      else setError(t('폴더를 끌어다 놓으세요.'));
      return;
    }
    if (!entry.isDirectory) {
      setError(t('파일이 아니라 폴더를 끌어다 놓으세요.'));
      return;
    }
    setResolving(true);
    try {
      const names = await readNames(entry as FileSystemDirectoryEntry);
      const r = await apiSend<{ matches: Match[] }>('POST', '/resolve-folder', { name: entry.name, entries: names });
      if (r.matches.length === 1 || (r.matches.length > 1 && r.matches[0].overlap > r.matches[1].overlap)) choose(r.matches[0].path);
      else if (r.matches.length > 1) setChoices(r.matches);
      else setError(t('"{0}" 폴더의 위치를 찾지 못했습니다. 사용자 폴더 밖에 있다면 "폴더 선택"을 쓰세요.', entry.name));
    } catch (err) {
      setError(String((err as Error).message ?? err));
    } finally {
      setResolving(false);
    }
  };

  return (
    <div
      className={cn('folder-input', dragging && 'is-dragging')}
      onDragEnter={(e) => {
        if (!accepts(e)) return;
        e.preventDefault();
        depth.current++;
        setDragging(true);
      }}
      onDragOver={(e) => {
        if (!accepts(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <InputGroup className="h-10" data-disabled={disabled || undefined}>
        <InputGroupAddon>
          <FolderSimpleIcon />
        </InputGroupAddon>
        <InputGroupInput
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder ?? t('예: C:\\work\\my-app — 폴더를 여기로 끌어다 놓아도 됩니다')}
          spellCheck={false}
          disabled={disabled}
          aria-label={label ?? t('프로젝트 경로')}
          list={recent.length ? listId : undefined}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton size="sm" variant="secondary" onClick={pick} disabled={disabled || picking}>
            <FolderOpenIcon data-icon="inline-start" />
            {picking ? t('선택 창 열림…') : t('폴더 선택')}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      {recent.length > 0 && (
        <datalist id={listId}>
          {recent.map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>
      )}
      {dragging && (
        <div className="drop-hint" aria-hidden="true">
          <UploadSimpleIcon />{t(' 여기에 놓으면 이 폴더로 정합니다')}
        </div>
      )}
      {resolving && <p className="muted small">{t('폴더 위치를 찾는 중…')}</p>}
      {choices.length > 0 && (
        <div className="drop-choices">
          <span className="muted small">{t('같은 이름의 폴더가 여러 개입니다. 고르세요:')}</span>
          {choices.map((m) => (
            <Button key={m.path} variant="outline" size="sm" className="justify-start" onClick={() => choose(m.path)}>
              {m.path}
            </Button>
          ))}
        </div>
      )}
      {error && <p className="warn-text small">{error}</p>}
      {picking &&
        createPortal(
          // Blocks the page until the OS dialog returns (choose or cancel), like a native modal.
          <div className="picker-overlay" role="alertdialog" aria-modal="true" aria-live="assertive" aria-label={t('폴더 선택 중')}>
            <div className="picker-card">
              <Icon name="folder" size={28} />
              <h2>{t('폴더 선택 창에서 폴더를 고르세요')}</h2>
              <p className="muted">{tj('"프로젝트 폴더 선택" 창에서 폴더를 고른 뒤 {0}을, 그만두려면 {1}를 누르세요. 창을 닫기 전까지 이 화면은 잠깁니다.', <b>{t('폴더 선택')}</b>, <b>{t('취소')}</b>)}</p>
              <p className="muted small">{t('창이 보이지 않으면 작업 표시줄에서 "프로젝트 폴더 선택"을 눌러 주세요.')}</p>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
