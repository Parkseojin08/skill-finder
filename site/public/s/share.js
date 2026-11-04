// The share page: reads the skill from the address after '#' (`v1.` + base64url JSON, made by the app's 공유 menu),
// checks every field and draws it as text only. The data never reaches this server (a fragment is not sent).
(function () {
  const T = {
    ko: {
      eyebrow: '// 공유된 스킬', riskNote: '이 링크의 내용(설명·위험 등급)은 링크를 만든 사람이 넣은 것이라 확인되지 않았습니다. 위험 등급은 원래 Skill Finder 규칙에 따른 참고 정보이며 안전 보증이 아닙니다. 설치 전에 저장소나 Skill Finder 앱에서 직접 확인하세요.',
      install: '설치 명령', copy: '복사', copied: '복사됨', cmdNote: '터미널에서 실행하면 설치 전에 확인을 묻습니다.',
      repo: '저장소 보기', local: '내 Skill Finder에서 열기', localNote: '내 PC에서 Skill Finder(기본 주소 127.0.0.1:4317)가 켜져 있어야 열립니다.',
      empty: '이 링크에 스킬 정보가 없거나 형식이 맞지 않습니다.', get: 'Skill Finder로 스킬을 찾고 설치 전에 확인하세요.', getLink: '소개·다운로드',
      low: '위험 낮음', medium: '주의', high: '위험 높음', title: '공유된 스킬',
    },
    en: {
      eyebrow: '// shared skill', riskNote: 'What this link shows (description, risk level) was put in by whoever made the link and is not verified. Risk levels come from Skill Finder rules and are a guide, not a safety guarantee. Check the repository or the Skill Finder app before installing.',
      install: 'Install command', copy: 'Copy', copied: 'Copied', cmdNote: 'Run in a terminal, it asks before installing.',
      repo: 'View repository', local: 'Open in my Skill Finder', localNote: 'Opens when Skill Finder is running on this PC (default 127.0.0.1:4317).',
      empty: 'This link has no skill information, or it is not in the expected format.', get: 'Find skills with Skill Finder and check them before installing.', getLink: 'About & download',
      low: 'Low risk', medium: 'Caution', high: 'High risk', title: 'Shared skill',
    },
    ja: {
      eyebrow: '// 共有されたスキル', riskNote: 'このリンクの内容(説明・リスク判定)はリンクを作った人が入れたもので、確認されていません。リスク判定は Skill Finder のルールによる目安で、安全を保証しません。インストール前にリポジトリや Skill Finder アプリで確認してください。',
      install: 'インストールコマンド', copy: 'コピー', copied: 'コピーしました', cmdNote: 'ターミナルで実行すると、インストール前に確認されます。',
      repo: 'リポジトリを見る', local: '自分の Skill Finder で開く', localNote: 'この PC で Skill Finder(既定 127.0.0.1:4317)が起動しているときに開きます。',
      empty: 'このリンクにはスキル情報がないか、形式が正しくありません。', get: 'Skill Finder でスキルを探し、インストール前に確認しましょう。', getLink: '紹介・ダウンロード',
      low: 'リスク低', medium: '注意', high: 'リスク高', title: '共有されたスキル',
    },
  };
  const FLAGS = {
    scripts: ['스크립트 포함', 'Includes scripts', 'スクリプトを含む'],
    preapprovedBash: ['Bash 사전 승인', 'Pre-approved Bash', 'Bash 事前承認'],
    unscopedBash: ['Bash 무제한', 'Unrestricted Bash', 'Bash 無制限'],
    shellInjection: ['셸 명령 주입', 'Shell command injection', 'シェルコマンド注入'],
    skillHooks: ['스킬 훅', 'Skill hooks', 'スキルフック'],
    pluginRootDependency: ['플러그인 전용', 'Plugin only', 'プラグイン専用'],
    pluginHooks: ['플러그인 훅', 'Plugin hooks', 'プラグインフック'],
    pluginMcp: ['MCP 서버', 'MCP server', 'MCP サーバー'],
    pluginBin: ['실행 파일(bin)', 'Executables (bin)', '実行ファイル(bin)'],
    pluginMonitors: ['모니터', 'Monitors', 'モニター'],
    curlPipeShell: ['원격 스크립트 실행', 'Runs a downloaded script', 'リモートスクリプト実行'],
    rmRf: ['rm -rf', 'rm -rf', 'rm -rf'],
    commandSource: ['command 출처', 'Command source', 'command ソース'],
    unscanned: ['끝까지 검사 못 함', 'Not fully checked', '最後まで検査できず'],
  };
  const LANGS = ['ko', 'en', 'ja'];

  const pickLang = () => {
    let saved = null;
    try { saved = localStorage.getItem('skill-finder-share-lang'); } catch (e) { /* not remembered */ }
    if (LANGS.includes(saved)) return saved;
    const nav = (navigator.language || 'ko').slice(0, 2);
    return LANGS.includes(nav) ? nav : 'en';
  };

  const decode = (hash) => {
    const m = /^#v1\.([A-Za-z0-9_-]{4,6000})$/.exec(hash);
    if (!m) return null;
    try {
      const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
      const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
      const data = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
      return data && typeof data === 'object' ? data : null;
    } catch (e) {
      return null;
    }
  };
  const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  // Anyone can write a link, so only the two command shapes the app makes are shown (one line, plain characters):
  // `claude plugin install <plugin>@<marketplace> --scope …` and `npx skills@x.y.z add <repo or GitHub URL> …`.
  const COMMANDS = [
    /^claude plugin install [A-Za-z0-9._-]+@[A-Za-z0-9._-]+ --scope (user|project|local)$/,
    /^npx skills@\d{1,4}\.\d{1,4}\.\d{1,6} add (https:\/\/github\.com\/[A-Za-z0-9._\/-]+|[A-Za-z0-9-]+\/[A-Za-z0-9._-]+)( --skill ([A-Za-z0-9._-]+|"[A-Za-z0-9 ._-]{1,64}") -a claude-code --copy( -g)?)?$/,
  ];
  const command = (v) => {
    const c = typeof v === 'string' ? v.trim() : '';
    return c.length <= 600 && COMMANDS.some((re) => re.test(c)) ? c : null;
  };

  const draw = (lang) => {
    const t = T[lang];
    document.documentElement.lang = lang;
    document.querySelectorAll('[data-t]').forEach((el) => { el.textContent = t[el.getAttribute('data-t')]; });
    const d = decode(location.hash);
    const name = d && str(d.n, 120);
    document.getElementById('skill').hidden = !name;
    document.getElementById('empty').hidden = !!name;
    if (!name) { document.title = 'Skill Finder — ' + t.title; return; }
    document.title = name + ' — Skill Finder';
    document.getElementById('name').textContent = name;
    document.getElementById('desc').textContent = str(d.d, 400) || '';
    const risk = ['low', 'medium', 'high'].includes(d.r) ? d.r : null;
    const badge = document.getElementById('risk');
    badge.hidden = !risk;
    if (risk) { badge.className = 'risk-badge ' + risk; badge.textContent = t[risk]; }
    const i = LANGS.indexOf(lang);
    const flags = Array.isArray(d.f) ? d.f.filter((f) => typeof f === 'string' && FLAGS[f]).slice(0, 12) : [];
    document.getElementById('flags').textContent = flags.map((f) => FLAGS[f][i]).join(' · ');
    const cmd = command(d.c);
    document.getElementById('cmd-box').hidden = !cmd;
    document.getElementById('cmd').textContent = cmd || '';
    // only the two places the app links to
    const url = str(d.u, 500);
    const repo = document.getElementById('repo');
    repo.hidden = !(url && /^https:\/\/(github\.com|skills\.sh)\/[\w.-]+\/[\w.-]+(\/[\w.\-/%@]*)?$/.test(url));
    if (!repo.hidden) repo.href = url;
    const id = str(d.i, 400);
    const ok = id && /^[\w:@./%+-]+$/.test(id);
    const local = document.getElementById('local');
    local.hidden = !ok;
    document.getElementById('local-note').hidden = !ok;
    if (ok) local.href = 'http://127.0.0.1:4317/skill?id=' + encodeURIComponent(id);
  };

  document.addEventListener('DOMContentLoaded', () => {
    const select = document.getElementById('lang');
    let lang = pickLang();
    select.value = lang;
    select.addEventListener('change', () => {
      lang = select.value;
      try { localStorage.setItem('skill-finder-share-lang', lang); } catch (e) { /* not remembered */ }
      draw(lang);
    });
    document.getElementById('copy').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      try {
        await navigator.clipboard.writeText(document.getElementById('cmd').textContent);
        btn.textContent = T[lang].copied;
        setTimeout(() => { btn.textContent = T[lang].copy; }, 1500);
      } catch (err) {
        getSelection().selectAllChildren(document.getElementById('cmd'));
      }
    });
    window.addEventListener('hashchange', () => draw(lang));
    draw(lang);
  });
})();
