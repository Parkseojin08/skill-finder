# 배포 절차

`scripts/release.mjs`가 순서를 묶는다. 커밋, `git push`, `npm publish`는 스크립트가 하지 않고 언제 할지만 알려 준다.
`bump`·`build`·`deploy`에 `--dry-run`을 붙이면 실행할 것만 보여 준다. `verify`는 원래 읽기만 한다.

## 준비물 (배포하는 PC에 한 번)

- Windows, Node 22.20 이상, git. 실행기는 .NET Framework의 `csc.exe`로 빌드한다.
- 업데이트 서명 키: `%USERPROFILE%\.skill-finder-release\update-signing-key.pem` (저장소 밖. 다른 곳이면 `SKILL_FINDER_SIGNING_KEY`).
  잃어버리면 설치된 앱이 업데이트를 받지 못하므로 백업해 둔다. 새 PC에는 백업한 키를 같은 위치에 둔다.
  `node scripts/signing-key.mjs`는 키가 없으면 새로 만드는데, 새 키로 서명한 업데이트는 이미 설치된 앱이 받지 않는다.
- 색인 `data/skill-finder.db`: zip과 npm 패키지에 넣는 "미리 만든 색인"의 원본. 앱을 켜서 동기화와 위험 규칙 재검사가 끝난 상태여야 한다.
- Cloudflare 로그인: `npx wrangler@4 whoami`로 확인하고, 안 돼 있으면 `npx wrangler@4 login`.
- npm 로그인: 세션이 2시간이라 올리기 직전에 `npm whoami`로 확인하고, 만료됐으면 `npm login`(2단계 인증).

## 순서

1. `CHANGELOG.md` 맨 위에 `## X.Y.Z` 제목과 `- `로 시작하는 줄을 쓴다. 30줄, 한 줄 300자까지이고 앱의 "새 버전" 창에 그대로 나온다.
2. `node scripts/release.mjs bump X.Y.Z`: `package.json`, `package-lock.json`(두 곳), CHANGELOG 제목의 날짜(오늘, `--date`로 지정)를 고친다.
   절이 없거나 비었거나 한도를 넘으면, 버전이 지금보다 높지 않으면 아무것도 고치지 않고 멈춘다.
3. 세 파일을 커밋한다. zip은 커밋된 내용으로 만든다.
4. `node scripts/release.mjs build`: `npm run package`(타입 검사, 배포본과 같은 Node로 테스트(`test:node`), zip, 서명된 `meta.json`을 `site/public/download/`에) 다음에
   `scripts/pack-npm.mjs`(`release/seojin08-skill-finder-X.Y.Z.tgz`). 순서가 중요하다: zip 스크립트가 `release/`를 먼저 비운다.
5. `git push origin main`
6. `node scripts/release.mjs deploy`: 배포 전 확인 뒤 `site/`에서 두 곳에 차례로 올리고, 두 주소를 확인한다.
   - 소개 페이지(Pages `seojin-skill-finder`, `site/wrangler.jsonc`): `npx wrangler@4 pages deploy`
   - 옛 업데이트 주소(Worker `skill-finder`, `site/wrangler.old-worker.jsonc`): `npx wrangler@4 deploy --config wrangler.old-worker.jsonc`.
     0.3.4 이하 설치가 이 workers.dev 주소에서 업데이트를 찾으므로 같은 파일을 둔다(D#6a6e).
7. `npm publish ./release/seojin08-skill-finder-X.Y.Z.tgz --access public` (`./`를 빼면 npm이 GitHub 저장소로 읽는다)

배포 전 확인: `site/public/download/meta.json`이 `package.json`과 같은 버전이고 서명이 맞는지, zip이 그 `meta.json`의 크기·SHA-256과 같은지,
zip을 지금 커밋에서 만들었는지(`build`가 `release/built-from.json`에 남긴 기록. build 뒤에 커밋을 더했거나 `--dirty`로 만들었으면 멈춘다),
커밋하지 않은 변경(추적하지 않는 새 파일 포함)이 없는지, 지금 브랜치가 main이고 origin의 main과 같은지.
실제 배포는 origin에 직접 물어보고(`git ls-remote`, 읽기만), `--dry-run`은 네트워크를 쓰지 않고 로컬의 `origin/main`(마지막 push·fetch 때 값)을 본다.

`node scripts/release.mjs verify`는 6번의 주소 확인만 따로 한다: 두 주소의 `download/meta.json`이 지금 버전이고 서명이 맞는지,
`download/skill-finder-win.zip`을 받아 그 `meta.json`의 크기·SHA-256과 같은지. 설치된 앱이 업데이트를 받을 때 보는 것과 같다.

## 실패했을 때

| 단계 | 보이는 것 | 할 일 |
|---|---|---|
| build | `커밋하지 않은 변경 N개가 압축에 들어갑니다` | 커밋한 뒤 다시. 그대로 만들려면 `build --dirty` |
| build | `스킬 N개가 옛 위험 규칙으로 검사돼 있습니다` | 앱을 켜서(`npm start`) 마켓플레이스 화면 "상태"의 "위험 규칙 재검사"가 끝난 뒤 다시. 원본이 사라져 재검사할 수 없는 스킬이 1% 이하이면 그 행만 빼고 만든다(D#c7cd) |
| build | 시간 기준 테스트 실패 (PC가 느릴 때) | 그 테스트 파일만 다시 돌려 확인한 뒤 build 다시 |
| build | `소개 페이지에 이미 X 버전이 올라가 있습니다` | 같은 버전을 다시 만들 때 나온다. 아직 배포 전이면 `build --same-version`, 이미 배포한 버전이면 버전을 올린다 |
| build | npm 패키지 단계만 실패 | zip은 만들어졌으니 `node scripts/pack-npm.mjs`만 다시 |
| deploy | 배포 전 확인에 `✖` | 그 줄이 말하는 대로: build 다시, 커밋, `git push origin main`, main 브랜치로 |
| deploy | `✖ zip을 만든 커밋` | zip을 `npm run package`로 직접 만들었거나 build 뒤에 커밋을 더한 경우다. `node scripts/release.mjs build`를 다시 (같은 버전이면 `--same-version`) |
| deploy | wrangler가 로그인을 요구하거나 실패 | `npx wrangler@4 login` 뒤 deploy 다시. 같은 파일을 다시 올려도 된다 |
| deploy | 주소 확인 실패 (옛 버전이 보임) | 잠시 뒤 `verify`. 계속이면 Cloudflare 대시보드에서 방금 올린 것이 production 배포인지 본다 |
| npm publish | 401 또는 404 | 로그인 만료. `npm login` 뒤 다시 |

확인을 건너뛰고 꼭 올려야 하면 `deploy --dry-run`이 보여 주는 두 명령을 `site/`에서 직접 실행하고 `verify`로 확인한다.
옛 Worker를 그만 둘 때는 `scripts/release.mjs`의 `SITES`에서 둘째 줄과 `site/wrangler.old-worker.jsonc`를 지운다.
