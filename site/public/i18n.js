// The landing page in Korean (written in index.html), English or Japanese. Runs before main.js (both deferred, in
// order), so the hero title is split for its animation after it is translated. The choice: ?lang=, then this
// browser's saved choice, then the browser's language. Every string here is this file's own, never page input.
(function () {
  var LANGS = ['ko', 'en', 'ja'];
  var KEY = 'skill-finder-site-lang';
  var T = {
    // Korean is written in index.html; only the strings page.js sets by script are here
    ko: {
      dlMac: 'macOS에 설치', dlLinux: 'Linux에 설치', dlPc: 'PC에 설치하기', copy: '복사', copied: '복사했습니다', shaNone: '(다음 배포부터 표시)',
    },
    en: {
      dlMac: 'Install on macOS', dlLinux: 'Install on Linux', dlPc: 'Install on your PC', copy: 'Copy', copied: 'Copied', shaNone: '(shown from the next release)',
      otherOs: 'Other systems →', close: 'Close',
      getTitle: 'Install Skill Finder',
      gMobile: 'Skill Finder is an app for your PC (Windows, macOS, Linux). Open this page on your computer to install it.',
      gWinD: 'Unpack the zip and run <code>SkillFinder.exe</code>: it installs itself and puts a <b>Skill Finder</b> shortcut on the desktop.',
      gUnix1: 'Have <a href="https://nodejs.org/en/download" rel="noopener">Node.js</a> 22.20 or later and git.',
      gUnix2: 'Run it in a terminal:',
      gUnix3: 'Your browser opens <code>127.0.0.1:4317</code>. Press <kbd>Ctrl</kbd>+<kbd>C</kbd> in the terminal to stop it.',
      gUnix4: 'To keep it as a command: <code>npm install -g @seojin08/skill-finder</code>, then <code>skill-finder</code>.',
      mkTabSearch: 'Search', mkTabReadme: 'README picks', mkTabInstalled: 'Installed', mkTabFav: 'Favorites', mkGo: 'Search',
      mkCount: '<b>34</b> results · 2.4 s', mkOfficial: 'Anthropic official', mkPartner: 'Partner', mkLow: 'Low risk', mkMid: 'Caution · MCP server',
      mkInstall: 'Install', mkSheetT: 'Install · personal (all projects)', mkC1: 'Files that come along checked', mkC2: 'No hooks or MCP servers', mkC3: 'The checked commit, as is',
      mkAlt: 'Skill Finder searching "extract tables from pdf": the pdf skill from Anthropic with 218K installs and low risk, its install panel showing the command and the checks, and a partner skill marked caution for its MCP server.',
      k1: 'skills indexed in the box — search from the first start', k2: 'sources in one search — 3 marketplaces, skills.sh, GitHub', k3: 'AI calls · skill code runs', k4: 'languages — 한국어 · English · 日本語',
      mqFav: 'Favorites', mqLang: '한국어 · English · 日本語',
      c5t: 'Favorites', c5d: 'Star skills and GitHub repositories to keep them, then narrow them down by type, provider and category.',
      c6t: 'Share with your team', c6d: 'Export your installed skills as a preset file your teammates install through the same confirm dialog, or send a share link that shows the risk signals and install command to people without the app.',
      tabWin: 'Windows', tabUnix: 'macOS · Linux',
      su1t: 'Prepare', su1d: '<a href="https://nodejs.org/en/download" rel="noopener">Node.js</a> 22.20 or later and git.',
      su2t: 'Run', su2d: 'In a terminal: <code>npx @seojin08/skill-finder</code>',
      su3t: 'Use', su3d: 'Your browser opens <code>127.0.0.1:4317</code>. <kbd>Ctrl</kbd>+<kbd>C</kbd> in the terminal stops it. To keep it as a command, <code>npm install -g @seojin08/skill-finder</code> and run <code>skill-finder</code>.',
      title: 'Skill Finder — find and install Claude Code skills',
      navHow: 'How it works', navFeatures: 'Features', navScreens: 'Screens', navStart: 'Get started', navDownload: 'Download',
      eyebrow: '// Claude Code skill finder',
      heroTitle: 'Find the skills<br /><em>you need, weigh them,</em><br />and install.',
      lead: 'Search skills spread across marketplaces, skills.sh and GitHub from one box, and see downloads, stars and risk signals side by side. When one fits, install it into Claude Code on your PC with one button.',
      dlWin: 'Download for Windows', howTo: 'How to use',
      fine: 'Free · open source (MIT) · Windows · macOS · Linux · Node.js 22.20+ · runs only on your PC',
      mqMarket: 'Marketplaces', mqRisk: 'Risk signals', mqScore: '4-part score', mqReadme: 'README recommendations', mqPinned: 'Installs the checked commit', mqLocal: '127.0.0.1 only',
      hHow: 'What happens in one search', hFeatures: 'What it does', hScreens: 'Screens', hStart: 'Get started', hSafety: 'Built to be safe', hChanges: 'Changes',
      n1t: 'Gather', n1d: 'Collects candidates from 3 sources at once',
      n2t: 'Check', n2d: 'Keeps only the SKILL.md that really installs',
      n3t: 'Order', n3d: 'Name or match → downloads → stars',
      n4t: 'Install', n4d: 'Shows what comes along, then installs',
      c1t: 'One search', c1d: 'Finds skills from official and community marketplaces, skills.sh and GitHub in one search box.',
      c2t: 'Risk signals and scores', c2d: 'Flags risk signals such as running a downloaded script, and scores relevance, popularity, recency and trust.',
      c3t: 'Recommendations from your README', c3d: 'Pick a project folder and it reads the README to suggest fitting skills, most popular first.',
      c4t: 'Shows everything before installing', c4d: 'Checks the scripts and files that come along with the same rules, shows the hooks and MCP servers a plugin runs as they are written, and installs exactly the commit it checked. It warns before overwriting a skill with the same name.',
      s1t: 'Why a score is what it is', s1d: 'Relevance, popularity, recency and trust as bars, with installs, stars, last update and license at a glance.',
      s2t: 'See the command before installing', s2d: 'Choose personal (all projects) or one project, and it shows the exact command, where it installs, the check of the files that come along and the hooks and MCP config, then installs. You can also copy the command and run it yourself.',
      barDetail: 'Skill details', barInstall: 'Install',
      st1t: 'Download', st1d: 'Get <a href="/download/skill-finder-win.zip" download="">skill-finder-win.zip</a> and unpack it anywhere.',
      st2t: 'Run', st2d: 'Double-click <code>SkillFinder.exe</code> to install it and get a <b>Skill Finder</b> shortcut on the desktop. Start it from the shortcut afterwards; if port 4317 is taken, a window lets you pick a free port.',
      st3t: 'Use', st3d: 'Your browser opens <code>127.0.0.1:4317</code>. Closing the black window turns it off.',
      npxD: 'With Node.js 22.20 or later, start it right from a terminal (works on Windows too).',
      cliT: 'Inside Claude Code', cliD: 'Read-only commands let Claude Code search for you. Installing and removing happen only in the app’s confirm dialog.',
      warnT: 'If Chrome blocks it as a file that is “not commonly downloaded”',
      warnD: 'This does not mean a virus was found; it is a newly released, unsigned program that few people have downloaded yet. In the downloads list, choose <b>Download suspicious file</b> (or <b>Keep</b>). If Windows says “Unknown publisher” when you run it, choose <b>More info → Run anyway</b>.',
      hash: 'To check that your file is the original on this page, run <code>Get-FileHash skill-finder-win.zip</code> in PowerShell and compare it with the value below.<br /><span class="sha">SHA-256 <code id="sha">loading…</code></span>',
      needT: 'Requirements',
      needL: '<li>Windows 10 / 11, macOS or Linux</li> <li><a href="https://nodejs.org/en/download" rel="noopener">Node.js</a> 22.20 or later — if Claude Code was installed with its native installer, install Node.js separately. SkillFinder.exe tells you when it is missing</li> <li>git — to read file lists of GitHub repositories</li> <li>Claude Code — to install and remove skills</li>',
      knowT: 'Good to know',
      knowL: '<li>An index of about 13,000 skills comes in the box, so you can search from the first start; only what changed since is gathered in the background.</li> <li>Add a GitHub token in Settings to include GitHub code search and keep star counts current.</li> <li>English queries are the most accurate; skill descriptions are mostly in English.</li> <li>Updates are automatic. Each start checks for a new version and, if there is one, downloads it (checking its signature, size and SHA-256) and switches. An update with a wrong signature is not taken. If the new version does not start, it rolls back on its own. Your skill list, history and token stay in <code>%LOCALAPPDATA%\\SkillFinder</code>.</li> <li><details><summary>If you used 0.1.0</summary>Download this zip and run it once. Put the old folder’s <code>data\\</code> and <code>.env</code> into the new folder and it moves them over.</details></li>',
      safetyL: '<li class="reveal">It opens only on your PC’s <code>127.0.0.1</code>; other devices on the network cannot reach it.</li> <li class="reveal">Queries go to skills.sh and GitHub to search. Search history, the index and your token stay on this PC in <code>%LOCALAPPDATA%\\SkillFinder</code> and are not sent anywhere (the token is used only with GitHub). skills CLI telemetry is off by default.</li> <li class="reveal">It does not run a skill’s code. It installs only after showing the command that will run.</li> <li class="reveal">No AI calls. Search and scores are computed from public information.</li> <li class="reveal">Risk levels come from fixed rules and are not a safety guarantee. Check the files and command it shows before installing.</li> <li class="reveal">The code is open on <a href="https://github.com/Parkseojin08/skill-finder" rel="noopener">GitHub</a> (MIT). Report security issues privately through the repository’s Security tab.</li>',
      changesD: 'Latest <b id="notes-ver">version</b> · read from the signed download info (meta.json). Full history: <a href="https://github.com/Parkseojin08/skill-finder/blob/main/CHANGELOG.md" rel="noopener">CHANGELOG.md</a>.',
      finalT: 'Get it and try it', issues: 'Report a problem',
      altSearch: 'Search results for "pull request review": filters on the left, a note on hidden results, and skill cards with downloads, stars, risk level and a favorite star.',
      altDetail: 'A skill page: score 73, description, installs, stars and context tokens, risk level and scan result.',
      altInstall: 'The Install tab: scope, the command to run and where it installs.', license: 'MIT License', notices: 'Open-source notices',
      disclaimer: 'Claude Code is a product of Anthropic; this app is a personal project not affiliated with Anthropic. Animation on this page: <a href="/vendor/anime-LICENSE.txt">anime.js (MIT)</a>',
    },
    ja: {
      dlMac: 'macOS にインストール', dlLinux: 'Linux にインストール', dlPc: 'PC にインストール', copy: 'コピー', copied: 'コピーしました', shaNone: '(次の配布から表示)',
      otherOs: 'ほかの OS →', close: '閉じる',
      getTitle: 'Skill Finder をインストール',
      gMobile: 'Skill Finder は PC(Windows・macOS・Linux)用のアプリです。パソコンでこのページを開いてインストールしてください。',
      gWinD: 'zip を展開して <code>SkillFinder.exe</code> を実行するとインストールされ、デスクトップに <b>Skill Finder</b> のショートカットができます。',
      gUnix1: '<a href="https://nodejs.org/ja/download" rel="noopener">Node.js</a> 22.20 以上と git を用意します。',
      gUnix2: 'ターミナルで実行します:',
      gUnix3: 'ブラウザに <code>127.0.0.1:4317</code> が開きます。終了はターミナルで <kbd>Ctrl</kbd>+<kbd>C</kbd>。',
      gUnix4: 'コマンドとして使い続けるなら <code>npm install -g @seojin08/skill-finder</code> のあと <code>skill-finder</code> で起動します。',
      mkTabSearch: '検索', mkTabReadme: 'README おすすめ', mkTabInstalled: 'インストール済み', mkTabFav: 'お気に入り', mkGo: '検索',
      mkCount: '<b>34</b> 件 · 2.4 秒', mkOfficial: 'Anthropic 公式', mkPartner: 'パートナー', mkLow: 'リスク低', mkMid: '注意 · MCP サーバー',
      mkInstall: 'インストール', mkSheetT: 'インストール · 個人(すべてのプロジェクト)', mkC1: '一緒に入るファイルを検査', mkC2: 'フック・MCP サーバーなし', mkC3: '検査したコミットのまま',
      mkAlt: 'Skill Finder で「extract tables from pdf」を検索した画面。218K インストールでリスク低の Anthropic の pdf スキル、コマンドと検査結果を示すインストール欄、MCP サーバーのため注意と表示されたパートナーのスキル。',
      k1: 'スキルの索引を同梱 — 初回起動からすぐ検索', k2: 'まとめて検索する場所 — マーケットプレイス 3・skills.sh・GitHub', k3: 'AI 呼び出し・スキルコードの実行', k4: '画面の言語 — 한국어 · English · 日本語',
      mqFav: 'お気に入り', mqLang: '한국어 · English · 日本語',
      c5t: 'お気に入り', c5d: 'スキルや GitHub リポジトリに星を付けて集め、種類・提供元・カテゴリで絞り込めます。',
      c6t: 'チームと共有', c6d: 'インストールしたスキルをプリセットファイルに書き出すと、チームメンバーが同じ確認画面を通して同じスキルをインストールできます。アプリのない人には、リスク信号とインストールコマンドが載った共有リンクを送れます。',
      tabWin: 'Windows', tabUnix: 'macOS · Linux',
      su1t: '準備', su1d: '<a href="https://nodejs.org/ja/download" rel="noopener">Node.js</a> 22.20 以上と git が必要です。',
      su2t: '実行', su2d: 'ターミナルで <code>npx @seojin08/skill-finder</code>',
      su3t: '使う', su3d: 'ブラウザに <code>127.0.0.1:4317</code> が開きます。終了はターミナルで <kbd>Ctrl</kbd>+<kbd>C</kbd>。コマンドとして使い続けるなら <code>npm install -g @seojin08/skill-finder</code> のあと <code>skill-finder</code> で起動します。',
      title: 'Skill Finder — Claude Code スキルの検索・インストール',
      navHow: '流れ', navFeatures: '機能', navScreens: '画面', navStart: 'はじめに', navDownload: 'ダウンロード',
      eyebrow: '// Claude Code スキルファインダー',
      heroTitle: '必要なスキルを<br /><em>探して、見極めて、</em><br />インストールまで。',
      lead: 'マーケットプレイス・skills.sh・GitHub に散らばったスキルをひとつの検索欄で探し、ダウンロード数・スター・リスク信号をまとめて確認できます。気に入ったらボタンひとつで PC の Claude Code にインストールします。',
      dlWin: 'Windows 版をダウンロード', howTo: '使い方を見る',
      fine: '無料・オープンソース(MIT) · Windows · macOS · Linux · Node.js 22.20 以上 · 自分の PC でのみ動作',
      mqMarket: 'マーケットプレイス', mqRisk: 'リスク信号', mqScore: '4つのスコア', mqReadme: 'README おすすめ', mqPinned: '検査したコミットをそのままインストール', mqLocal: '127.0.0.1 専用',
      hHow: '1回の検索で起きること', hFeatures: 'できること', hScreens: '実際の画面', hStart: 'はじめに', hSafety: '安全に作りました', hChanges: '変更履歴',
      n1t: '集める', n1d: '3か所から候補を同時に収集',
      n2t: '確認', n2d: '実際にインストールされる SKILL.md だけを残す',
      n3t: '並べる', n3d: '名前・一致 → ダウンロード → スター順',
      n4t: 'インストール', n4d: '一緒に入るものまで見せてからインストール',
      c1t: 'まとめて検索', c1d: '公式・コミュニティのマーケットプレイス、skills.sh、GitHub のスキルをひとつの検索欄で探します。',
      c2t: 'リスク信号とスコア', c2d: 'リモートスクリプトの実行などのリスク信号を表示し、関連度・人気・新しさ・信頼度でスコアを付けます。',
      c3t: 'README からおすすめ', c3d: 'プロジェクトフォルダを選ぶと README を読み、合うスキルを人気順に選びます。',
      c4t: 'インストール前にすべて見せる', c4d: '一緒にインストールされるスクリプトや参考ファイルを同じルールで検査し、プラグインが実行するフックや MCP サーバーを原文で見せてから、検査したコミットをそのままインストールします。同じ名前のスキルを上書きするときは事前に知らせます。',
      s1t: 'スコアの理由まで', s1d: '関連度・人気・新しさ・信頼度をバーで示し、インストール数・スター・最終更新日・ライセンスをひと目で確認できます。',
      s2t: '実行されるコマンドを先に見てからインストール', s2d: '個人(すべてのプロジェクト)か特定のプロジェクトを選ぶと、実際に実行するコマンド、インストール先、一緒に入るファイルの検査結果、フックや MCP の原文を見せてからインストールします。コマンドをコピーして自分で実行することもできます。',
      barDetail: 'スキル詳細', barInstall: 'インストール',
      st1t: 'ダウンロード', st1d: '<a href="/download/skill-finder-win.zip" download="">skill-finder-win.zip</a> を入手し、好きな場所に展開します。',
      st2t: '実行', st2d: '<code>SkillFinder.exe</code> をダブルクリックするとインストールされ、デスクトップに <b>Skill Finder</b> のショートカットができます。次回からはショートカットで起動し、ポート 4317 が使用中なら空いているポートを選ぶ画面が出ます。',
      st3t: '使う', st3d: 'ブラウザに <code>127.0.0.1:4317</code> が開きます。黒いウィンドウを閉じると終了します。',
      npxD: 'Node.js 22.20 以上があれば、ターミナルからすぐに起動できます(Windows でも使えます)。',
      cliT: 'Claude Code の中で', cliD: '読み取り専用のコマンドがあるので、Claude Code に探させることができます。インストールと削除はアプリの確認画面でのみ行います。',
      warnT: 'Chrome が「一般的にダウンロードされていないファイル」としてブロックした場合',
      warnD: 'ウイルスが見つかったという意味ではなく、新しく配布された署名のないプログラムで、ダウンロードした人がまだ少ないという意味です。ダウンロード一覧で<b>不審なファイルをダウンロード</b>(または<b>保存</b>)を選ぶと入手できます。実行時に Windows が「不明な発行元」と表示したら、<b>詳細情報 → 実行</b>を選んでください。',
      hash: '入手したファイルがこのページの原本と同じか確かめるには、PowerShell で <code>Get-FileHash skill-finder-win.zip</code> を実行して下の値と比べてください。<br /><span class="sha">SHA-256 <code id="sha">読み込み中…</code></span>',
      needT: '必要なもの',
      needL: '<li>Windows 10 / 11・macOS・Linux</li> <li><a href="https://nodejs.org/ja/download" rel="noopener">Node.js</a> 22.20 以上 — Claude Code をネイティブインストーラーで入れた場合は別途インストールが必要です。ない場合は SkillFinder.exe が知らせます</li> <li>git — GitHub リポジトリのファイル一覧を読むときに使用</li> <li>Claude Code — スキルのインストール・削除に使用</li>',
      knowT: '知っておくこと',
      knowL: '<li>約 13,000 件のスキル索引が同梱されているので、初回起動からすぐ検索できます。その後に変わった分だけをバックグラウンドで集めます。</li> <li>設定画面に GitHub トークンを入れると GitHub 検索が加わり、スター数も新しく保たれます。</li> <li>検索語は英語が最も正確です。スキルの説明はほとんど英語です。</li> <li>アップデートは自動です。起動のたびに新しいバージョンを確認し、あればダウンロード(署名・サイズ・SHA-256 を確認)して入れ替えます。署名が合わないものは受け取りません。新しいバージョンが起動しなければ自動で元に戻します。スキル一覧・履歴・トークンは <code>%LOCALAPPDATA%\\SkillFinder</code> にあるので引き継がれます。</li> <li><details><summary>0.1.0 を使っていた場合</summary>この zip を入手して一度実行してください。以前のフォルダの <code>data\\</code> と <code>.env</code> を新しいフォルダに入れておくと移します。</details></li>',
      safetyL: '<li class="reveal">自分の PC の <code>127.0.0.1</code> でのみ開きます。同じネットワークの他の機器からも接続できません。</li> <li class="reveal">検索語は検索のために skills.sh・GitHub に送ります。検索履歴・索引・トークンはこの PC の <code>%LOCALAPPDATA%\\SkillFinder</code> にだけ保存し、外部には送りません(トークンは GitHub にのみ使います)。skills CLI の利用統計の送信は既定でオフです。</li> <li class="reveal">スキルのコードは実行しません。インストールは実行されるコマンドを先に見せてから行います。</li> <li class="reveal">AI を呼び出しません。検索とスコアはすべて公開情報から計算します。</li> <li class="reveal">リスクの判定は決まったルールによるもので、安全を保証しません。インストール前に表示されるファイルとコマンドを確認してください。</li> <li class="reveal">コードは <a href="https://github.com/Parkseojin08/skill-finder" rel="noopener">GitHub</a> で公開しています(MIT)。セキュリティの問題はリポジトリの Security タブから非公開で知らせてください。</li>',
      changesD: '最新 <b id="notes-ver">バージョン</b> · 署名されたダウンロード情報(meta.json)から読み込みます。全履歴は <a href="https://github.com/Parkseojin08/skill-finder/blob/main/CHANGELOG.md" rel="noopener">CHANGELOG.md</a>。',
      finalT: '今すぐ入手して使ってみましょう', issues: '問題を報告',
      altSearch: '「pull request review」の検索結果。左にフィルター、非表示の結果の案内、ダウンロード数・スター数・リスク判定の付いたスキルカードとお気に入りの星。',
      altDetail: 'スキル詳細画面。73 点、説明、インストール数・スター数・コンテキストトークン、リスク判定と検査結果。',
      altInstall: 'インストールタブ。範囲の選択、実行するコマンド、インストール先。', license: 'MIT ライセンス', notices: 'オープンソースの表記',
      disclaimer: 'Claude Code は Anthropic の製品であり、このアプリは Anthropic と関係のない個人プロジェクトです。このページのアニメーション: <a href="/vendor/anime-LICENSE.txt">anime.js (MIT)</a>',
    },
  };

  function pick() {
    var q = new URLSearchParams(location.search).get('lang');
    if (LANGS.indexOf(q) >= 0) return q;
    try {
      var saved = localStorage.getItem(KEY);
      if (LANGS.indexOf(saved) >= 0) return saved;
    } catch (e) { /* not remembered */ }
    var nav = (navigator.language || 'ko').slice(0, 2).toLowerCase();
    return nav === 'ko' ? 'ko' : nav === 'ja' ? 'ja' : 'en';
  }

  var lang = pick();
  var dict = lang === 'ko' ? null : T[lang];
  window.__siteLang = lang;
  /** A string page.js sets by script, in the page's language. */
  window.__siteText = function (key) {
    return T[lang][key] != null ? T[lang][key] : T.ko[key];
  };
  document.documentElement.lang = lang;
  if (dict) {
    document.title = dict.title;
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      var v = dict[el.getAttribute('data-i18n')];
      if (v != null) el.innerHTML = v;
    });
    document.querySelectorAll('[data-i18n-alt]').forEach(function (el) {
      var v = dict[el.getAttribute('data-i18n-alt')];
      if (v != null) el.alt = v;
    });
    document.querySelectorAll('[data-i18n-label]').forEach(function (el) {
      var v = dict[el.getAttribute('data-i18n-label')];
      if (v != null) el.setAttribute('aria-label', v);
    });
  }
  var select = document.getElementById('site-lang');
  if (select) {
    select.value = lang;
    select.addEventListener('change', function () {
      try { localStorage.setItem(KEY, select.value); } catch (e) { /* only this visit */ }
      var u = new URL(location.href);
      u.searchParams.delete('lang');
      location.href = u.toString();
    });
  }
})();
