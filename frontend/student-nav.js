/* frontend/student-nav.js — UTAR SRC Voting System v5
   ─────────────────────────────────────────────────────────────
   One navigation bar for every student page.

   The four student pages had grown four different bars: different
   labels for the same destination ("Sign Out" / "Sign out", "My
   Profile" / "My profile"), different sets of links, and a different
   order on each — so the same button moved as you navigated. This
   builds one bar and marks where you are.

   Include after the page's own <nav>:
       <script src="student-nav.js"></script>

   It replaces the contents of that <nav>, reusing the page's existing
   .nav-brand and .btn-sm styles so it still looks native to each page.
   ───────────────────────────────────────────────────────────── */
(function () {
  var nav = document.querySelector('nav');
  if (!nav) return;

  var user = null;
  try { user = JSON.parse(sessionStorage.getItem('user') || 'null'); } catch (e) { user = null; }
  // The Election Committee has its own panel and must not be handed
  // student navigation — results.html is reachable by both.
  if (user && user.role === 'election_committee') return;

  var here = (location.pathname.split('/').pop() || 'vote.html').toLowerCase();

  /* Order is deliberate and fixed. The three places a student goes
     sit on the left; who they are and how to leave sit on the right,
     in the same spot on every page. */
  var LINKS = [
    { file: 'vote.html',     label: 'Elections',    icon: '🗳️' },
    { file: 'endorse.html',  label: 'Endorsements', icon: '🤝', badge: true },
    { file: 'results.html',  label: 'Results',      icon: '📊' },
  ];

  var css = document.createElement('style');
  css.textContent = [
    'nav .sn-wrap{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
    'nav .sn-right{display:flex;align-items:center;gap:8px;margin-left:auto;flex-wrap:wrap}',
    'nav .sn-sep{width:1px;height:20px;background:currentColor;opacity:.18;margin:0 2px}',
    'nav .btn-sm.sn-on{border-color:var(--teal,#00c2a8);color:var(--teal,#00c2a8);font-weight:700}',
    'nav .sn-who{font-size:.82rem;opacity:.75;white-space:nowrap;margin-right:2px}',
    'nav .sn-who b{opacity:1;font-weight:600}',
    'nav .sn-badge{display:inline-block;min-width:17px;padding:0 5px;margin-left:6px;border-radius:99px;',
      'background:#f5c842;color:#0b1628;font-size:.68rem;font-weight:700;line-height:17px;text-align:center}',
    '@media(max-width:720px){nav .sn-who{display:none}nav .btn-sm{padding:6px 10px;font-size:.78rem}}',
  ].join('');
  document.head.appendChild(css);

  var brand = nav.querySelector('.nav-brand');
  var brandText = brand ? brand.textContent.trim() : 'UTAR SRC Voting';

  // Pages can pin their own action (Results has a Refresh) by leaving
  // an element with data-sn-extra inside <nav>; it is kept and shown
  // beside the shared links rather than being thrown away.
  var extra = nav.querySelector('[data-sn-extra]');

  nav.innerHTML = '';
  nav.classList.add('sn-nav');

  var b = document.createElement('div');
  b.className = 'nav-brand';
  b.textContent = brandText;
  b.style.cursor = 'pointer';
  b.addEventListener('click', function () { location.href = 'vote.html'; });
  nav.appendChild(b);

  var wrap = document.createElement('div');
  wrap.className = 'sn-wrap sn-right';

  LINKS.forEach(function (l) {
    var btn = document.createElement('button');
    btn.className = 'btn-sm' + (here === l.file ? ' sn-on' : '');
    btn.innerHTML = l.icon + ' ' + l.label +
      (l.badge ? '<span class="sn-badge" id="snEndBadge" style="display:none"></span>' : '');
    if (here === l.file) btn.setAttribute('aria-current', 'page');
    btn.addEventListener('click', function () {
      if (here !== l.file) location.href = l.file;
    });
    wrap.appendChild(btn);
  });

  if (extra) { extra.classList.add('btn-sm'); wrap.appendChild(extra); }

  var sep = document.createElement('div');
  sep.className = 'sn-sep';
  wrap.appendChild(sep);

  if (user && user.full_name) {
    var who = document.createElement('span');
    who.className = 'sn-who';
    who.innerHTML = '👤 <b></b>';
    who.querySelector('b').textContent = user.full_name;
    wrap.appendChild(who);
  }

  var prof = document.createElement('button');
  prof.className = 'btn-sm' + (here === 'profile.html' ? ' sn-on' : '');
  prof.textContent = 'My Profile';
  prof.addEventListener('click', function () {
    if (here !== 'profile.html') location.href = 'profile.html';
  });
  wrap.appendChild(prof);

  var out = document.createElement('button');
  out.className = 'btn-sm';
  out.textContent = 'Sign Out';
  out.addEventListener('click', function () {
    if (typeof window.logout === 'function') return window.logout();
    sessionStorage.clear();
    location.href = 'login.html';
  });
  wrap.appendChild(out);

  nav.appendChild(wrap);

  /* The endorsement badge is the one piece of live state in the bar,
     and it was previously loaded by two pages under two different ids.
     The bar owns it now, so it reads the same everywhere. */
  if (user && user.id) {
    fetch('/api/endorsements/pending/' + user.id)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var n = typeof d.pending_count === 'number'
          ? d.pending_count
          : (d.requests || []).filter(function (e) { return e.status === 'invited'; }).length;
        var el = document.getElementById('snEndBadge');
        if (el && n > 0) { el.textContent = n; el.style.display = 'inline-block'; }
      })
      .catch(function () {});
  }
})();
