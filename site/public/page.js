// What the page does besides motion: the download buttons follow this visitor's OS (the zip on Windows, the npx
// command on macOS and Linux), the install dialog and the start section's OS tabs, copy buttons, and the download
// size, checksum and change notes from the signed meta.json. Runs after i18n.js; without it every link still
// downloads the Windows zip and both sets of steps are shown.
(function () {
  var tx = window.__siteText || function (k) { return k; };

  /** 'win' | 'mac' | 'linux' | 'mobile' (a phone or tablet: the app needs a PC). */
  function detect() {
    var ua = navigator.userAgent || '';
    var platform = ((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '').toLowerCase();
    if (/android|iphone|ipad|ipod/i.test(ua) || (platform === 'macintel' && navigator.maxTouchPoints > 1)) return 'mobile';
    if (platform.indexOf('win') === 0 || /windows/i.test(ua)) return 'win';
    if (platform.indexOf('mac') === 0 || /mac os x/i.test(ua)) return 'mac';
    if (/linux|x11|cros/i.test(platform + ' ' + ua)) return 'linux';
    return 'win';
  }
  var os = detect();
  document.documentElement.setAttribute('data-os', os);

  /* ── the install dialog: Windows zip, or the npx steps for macOS and Linux ── */
  var dialog = document.getElementById('get');
  function showTab(tab) {
    dialog.querySelectorAll('[data-get-os]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-get-os') === tab));
    });
    dialog.querySelectorAll('[data-get-panel]').forEach(function (p) {
      p.hidden = p.getAttribute('data-get-panel') !== (tab === 'win' ? 'win' : 'unix');
    });
  }
  function openGet(tab) {
    if (!dialog || typeof dialog.showModal !== 'function') return false;
    showTab(tab === 'mobile' ? 'win' : tab);
    document.getElementById('get-mobile').hidden = os !== 'mobile';
    dialog.showModal();
    return true;
  }
  if (dialog) {
    dialog.querySelectorAll('[data-get-os]').forEach(function (b) {
      b.addEventListener('click', function () { showTab(b.getAttribute('data-get-os')); });
    });
    // a click on the backdrop closes it, as Esc does
    dialog.addEventListener('click', function (e) { if (e.target === dialog) dialog.close(); });
  }
  document.querySelectorAll('[data-get]').forEach(function (b) {
    b.addEventListener('click', function () { openGet(os); });
  });

  /* ── download buttons: Windows downloads at once; elsewhere they open the steps for this OS ── */
  if (os !== 'win') {
    var label = tx(os === 'mac' ? 'dlMac' : os === 'linux' ? 'dlLinux' : 'dlPc');
    document.querySelectorAll('a[data-dl]').forEach(function (a) {
      var l = a.querySelector('.dl-label');
      if (l) l.textContent = label;
      var m = a.querySelector('.dl-meta');
      if (m) {
        m.classList.remove('zip'); // so meta.json does not put the zip's size back
        m.textContent = os === 'mobile' ? 'Windows · macOS · Linux' : 'npx · Node.js 22.20+';
      }
      a.addEventListener('click', function (e) {
        if (openGet(os)) e.preventDefault();
      });
    });
  }

  /* ── start section: the steps for one OS at a time, this visitor's first ── */
  function startTab(tab) {
    document.querySelectorAll('[data-start-os]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-start-os') === tab));
    });
    document.querySelectorAll('[data-start-panel]').forEach(function (p) {
      p.hidden = p.getAttribute('data-start-panel') !== tab;
    });
  }
  document.querySelectorAll('[data-start-os]').forEach(function (b) {
    b.addEventListener('click', function () { startTab(b.getAttribute('data-start-os')); });
  });
  if (document.querySelector('[data-start-os]')) startTab(os === 'mac' || os === 'linux' ? 'unix' : 'win');

  /* ── copy buttons ── */
  document.querySelectorAll('[data-copy]').forEach(function (b) {
    b.addEventListener('click', function () {
      var done = function () {
        b.textContent = tx('copied');
        setTimeout(function () { b.textContent = tx('copy'); }, 1600);
      };
      if (navigator.clipboard) navigator.clipboard.writeText(b.getAttribute('data-copy')).then(done, function () {});
    });
  });

  /* ── download size, date, checksum and change notes from the build (scripts/package-win.mjs) ── */
  fetch('/download/meta.json')
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (m) {
      if (!m) return;
      var zip = 'zip · ' + (m.bytes / 1048576).toFixed(1) + 'MB · ' + m.builtAt;
      document.querySelectorAll('.dl-meta.zip').forEach(function (el) { el.textContent = zip; });
      document.getElementById('ver').textContent = m.version;
      document.getElementById('sha').textContent = m.sha256 || tx('shaNone');
      // the version's change notes (signed with the release, CHANGELOG.md), drawn as text
      var notes = Array.isArray(m.notes) ? m.notes.filter(function (n) { return typeof n === 'string'; }).slice(0, 30) : [];
      document.getElementById('notes-ver').textContent = m.version;
      var list = document.getElementById('notes');
      notes.forEach(function (n) {
        var li = document.createElement('li');
        li.textContent = n;
        list.append(li);
      });
      if (!notes.length) document.getElementById('changes').hidden = true;
    })
    .catch(function () {});
})();
