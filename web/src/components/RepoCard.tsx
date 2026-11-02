import { ArrowSquareOutIcon, DownloadSimpleIcon, GithubLogoIcon, StarIcon } from '@phosphor-icons/react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCount } from '../labels.ts';
import { TRANSLATE_TO, useKorean } from '../translate.ts';
import type { RepoResult } from '../types.ts';
import { RepoInstallDialog } from './RepoInstallDialog.tsx';
import { t } from '../i18n.ts';

/**
 * A GitHub repository matching a one-word query by name ("rea" → morluto/rea), shown above the skills.
 * Its name and the 설치 button install the repo's skills; GitHub has its own link.
 */
export function RepoCard({ repo, onOpenSkill }: { repo: RepoResult; onOpenSkill: (id: string) => void }) {
  const { ko } = useKorean(repo.description ?? '', 0);
  const [installing, setInstalling] = useState(false);
  const installable = repo.skills.filter((s) => s.installable).length;
  return (
    <Card className="repo-card">
      <CardHeader>
        <CardTitle className="repo-title">
          <GithubLogoIcon />
          <button type="button" className="repo-name" onClick={() => setInstalling(true)} disabled={installable === 0} title={t('이 저장소의 스킬 설치')}>
            {repo.repo}
          </button>
          <a className="repo-gh" href={repo.url} target="_blank" rel="noopener noreferrer" aria-label={t('{0} GitHub에서 보기', repo.repo)} title={t('GitHub에서 보기')}>
            <ArrowSquareOutIcon />
          </a>
        </CardTitle>
        {repo.description && (
          <CardDescription title={ko ? repo.description : undefined} lang={ko ? (TRANSLATE_TO ?? 'en') : 'en'}>
            {ko ?? repo.description}
          </CardDescription>
        )}
        <CardAction className="flex items-center gap-2">
          {repo.stars != null && (
            <Badge variant="outline">
              <StarIcon data-icon="inline-start" />
              {formatCount(repo.stars)}
            </Badge>
          )}
          <Button size="sm" onClick={() => setInstalling(true)} disabled={installable === 0}>
            <DownloadSimpleIcon data-icon="inline-start" />
            {t('설치')}
          </Button>
        </CardAction>
      </CardHeader>
      {repo.topics.length > 0 && (
        <CardContent className="flex flex-wrap gap-1">
          {repo.topics.map((t) => (
            <Badge key={t} variant="secondary">
              {t}
            </Badge>
          ))}
        </CardContent>
      )}
      <CardFooter className="flex flex-wrap items-center gap-2">
        <span className="muted small">{t('스킬 {0}개', repo.skills.length)}</span>
        {repo.skills.map((s) => (
          <Button key={s.id} variant="outline" size="sm" onClick={() => onOpenSkill(s.id)}>
            {s.name}
          </Button>
        ))}
        <Button variant="ghost" size="sm" className="ml-auto" render={<a href={repo.url} target="_blank" rel="noopener noreferrer" />}>
          {t('GitHub에서 보기')}
          <ArrowSquareOutIcon data-icon="inline-end" />
        </Button>
      </CardFooter>
      <RepoInstallDialog repo={repo} open={installing} onOpenChange={setInstalling} />
    </Card>
  );
}
