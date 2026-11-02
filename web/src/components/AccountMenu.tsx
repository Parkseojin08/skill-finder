import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { onAskLogin, signIn, signOut, useAccount } from '../account.ts';

/**
 * The account corner of the menu bar (user decision 2026-11-02): 로그인 when signed out, the name with
 * 즐겨찾기 and 로그아웃 when signed in. Accounts live in this PC's Skill Finder only.
 */
export function AccountMenu({ onFavorites }: { onFavorites: () => void }) {
  const { user, loaded } = useAccount();
  const [open, setOpen] = useState(false);
  const [why, setWhy] = useState<string | null>(null);
  const menuRef = useRef<HTMLDetailsElement>(null);
  useEffect(
    () =>
      onAskLogin((w) => {
        setWhy(w);
        setOpen(true);
      }),
    [],
  );
  if (!loaded) return null;
  return (
    <div className="account">
      {user ? (
        <details className="account-menu" ref={menuRef}>
          <summary className="account-name" title="계정">
            {user.username}
          </summary>
          <div className="account-items">
            <button
              type="button"
              className="ghost"
              onClick={() => {
                if (menuRef.current) menuRef.current.open = false;
                onFavorites();
              }}
            >
              즐겨찾기
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => {
                if (menuRef.current) menuRef.current.open = false;
                void signOut();
              }}
            >
              로그아웃
            </button>
          </div>
        </details>
      ) : (
        <button
          type="button"
          className="ghost account-login"
          onClick={() => {
            setWhy(null);
            setOpen(true);
          }}
        >
          로그인
        </button>
      )}
      <LoginDialog open={open} why={why} onOpenChange={setOpen} />
    </div>
  );
}

function LoginDialog({ open, why, onOpenChange }: { open: boolean; why: string | null; onOpenChange: (o: boolean) => void }) {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setPassword('');
    setError(null);
  }, [open]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(mode, username.trim(), password);
      onOpenChange(false);
    } catch (err) {
      setError(String((err as Error).message ?? err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="login-dialog sm:max-w-sm">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{mode === 'login' ? '로그인' : '회원가입'}</DialogTitle>
            <DialogDescription>{why ?? '즐겨찾기를 계정별로 모아 둡니다. 계정은 이 PC의 Skill Finder에만 저장되고 밖으로 보내지 않습니다.'}</DialogDescription>
          </DialogHeader>
          <div className="login-modes" role="group" aria-label="로그인 또는 회원가입">
            <button type="button" className={mode === 'login' ? 'current' : 'ghost'} aria-pressed={mode === 'login'} onClick={() => setMode('login')}>
              로그인
            </button>
            <button type="button" className={mode === 'signup' ? 'current' : 'ghost'} aria-pressed={mode === 'signup'} onClick={() => setMode('signup')}>
              회원가입
            </button>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="login-name">아이디</Label>
            <Input id="login-name" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required minLength={3} maxLength={32} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="login-pass">비밀번호{mode === 'signup' ? ' (8자 이상)' : ''}</Label>
            <Input
              id="login-pass"
              type="password"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={mode === 'signup' ? 8 : 1}
              maxLength={200}
            />
          </div>
          {error && (
            <p className="warn-box small" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="submit" disabled={busy || !username.trim() || !password}>
              {busy ? '확인 중…' : mode === 'login' ? '로그인' : '가입하고 로그인'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
