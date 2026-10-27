import { ArrowSquareOutIcon, GithubLogoIcon, StarIcon } from '@phosphor-icons/react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCount } from '../labels.ts';
import { useKorean } from '../translate.ts';
import type { RepoResult } from '../types.ts';

/** A GitHub repository matching a one-word query by name ("rea" → morluto/rea), shown above the skills. */
export function RepoCard({ repo, onOpenSkill }: { repo: RepoResult; onOpenSkill: (id: string) => void }) {
  const { ko } = useKorean(repo.description ?? '', 0);
  return (
    <Card className="repo-card">
      <CardHeader>
        <CardTitle className="repo-title">
          <GithubLogoIcon />
          <a href={repo.url} target="_blank" rel="noopener noreferrer">
            {repo.repo}
          </a>
        </CardTitle>
        {repo.description && (
          <CardDescription title={ko ? repo.description : undefined} lang={ko ? 'ko' : 'en'}>
            {ko ?? repo.description}
          </CardDescription>
        )}
        {repo.stars != null && (
          <CardAction>
            <Badge variant="outline">
              <StarIcon data-icon="inline-start" />
              {formatCount(repo.stars)}
            </Badge>
          </CardAction>
        )}
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
        <span className="muted small">스킬 {repo.skills.length}개</span>
        {repo.skills.map((s) => (
          <Button key={s.id} variant="outline" size="sm" onClick={() => onOpenSkill(s.id)}>
            {s.name}
          </Button>
        ))}
        <Button variant="ghost" size="sm" className="ml-auto" render={<a href={repo.url} target="_blank" rel="noopener noreferrer" />}>
          GitHub에서 보기
          <ArrowSquareOutIcon data-icon="inline-end" />
        </Button>
      </CardFooter>
    </Card>
  );
}
