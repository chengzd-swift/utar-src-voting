/* frontend/chat-widget.js — UTAR SRC Voting System v5
   ─────────────────────────────────────────────────────────────
   The election assistant, as a floating panel on every student
   page. One <script> tag is the whole integration:

       <script src="chat-widget.js"></script>

   It builds its own markup and styles inside a shadow root, so it
   cannot inherit or leak CSS from the page it sits on — the pages
   here range from a dark portal to a light registration form.

   No API key is present anywhere in this file. The browser only
   ever talks to /api/chat on our own server.
   ───────────────────────────────────────────────────────────── */
(function () {
  if (window.__srcChatLoaded) return;
  window.__srcChatLoaded = true;

  var STORE = 'src-chat-history';
  var history = [];
  try { history = JSON.parse(sessionStorage.getItem(STORE) || '[]'); } catch (e) { history = []; }

  var SUGGESTIONS = [
    'Am I eligible to vote?',
    'Who can stand for the SRC?',
    'How do the four endorsers work?',
    'Why do I need MetaMask?',
    'Can I change my vote?'
  ];

  var host = document.createElement('div');
  host.id = 'src-chat-host';
  host.style.cssText = 'position:fixed;right:0;bottom:0;z-index:2147483000';
  document.body.appendChild(host);
  var root = host.attachShadow({ mode: 'open' });

  root.innerHTML = [
    '<style>',
    ':host,*{box-sizing:border-box}',
    '.launch{position:fixed;right:22px;bottom:22px;width:56px;height:56px;border-radius:50%;',
      'border:none;cursor:pointer;background:linear-gradient(135deg,#0f9e8e,#0b7d70);color:#fff;',
      'font-size:24px;box-shadow:0 8px 24px rgba(4,42,38,.38);display:flex;align-items:center;',
      'justify-content:center;transition:transform .18s}',
    '.launch:hover{transform:translateY(-2px)}',
    '.launch:focus-visible{outline:3px solid #7fe3d6;outline-offset:3px}',
    '.launch .dot{position:absolute;top:2px;right:2px;width:13px;height:13px;border-radius:50%;',
      'background:#f5c842;border:2px solid #fff;display:none}',
    '.launch.unread .dot{display:block}',
    '.panel{position:fixed;right:22px;bottom:88px;width:380px;max-width:calc(100vw - 28px);',
      'height:min(560px,calc(100vh - 130px));background:#fff;border-radius:16px;overflow:hidden;',
      'box-shadow:0 20px 60px rgba(6,20,34,.28);display:none;flex-direction:column;',
      "font-family:'DM Sans',system-ui,-apple-system,Segoe UI,sans-serif;color:#12263f}",
    '.panel.open{display:flex}',
    '@media(max-width:520px){.panel{right:8px;left:8px;width:auto;bottom:80px;height:calc(100vh - 100px)}',
      '.launch{right:14px;bottom:14px}}',
    '.head{background:linear-gradient(135deg,#0f2f4a,#0b7d70);color:#fff;padding:14px 16px;',
      'display:flex;align-items:center;gap:11px;flex:0 0 auto}',
    '.avatar{width:34px;height:34px;border-radius:10px;background:rgba(255,255,255,.16);display:flex;',
      'align-items:center;justify-content:center;font-size:17px}',
    '.head h2{margin:0;font-size:.95rem;font-weight:700;letter-spacing:.01em}',
    '.head p{margin:1px 0 0;font-size:.73rem;opacity:.8}',
    '.hbtn{margin-left:auto;background:none;border:none;color:#fff;font-size:17px;cursor:pointer;',
      'opacity:.8;line-height:1;padding:5px 7px;border-radius:6px}',
    '.hbtn:hover{opacity:1;background:rgba(255,255,255,.14)}',
    '.hbtn:focus-visible,.close:focus-visible{outline:2px solid #7fe3d6;outline-offset:1px}',
    '.close{background:none;border:none;color:#fff;font-size:20px;cursor:pointer;',
      'opacity:.85;line-height:1;padding:4px 6px;border-radius:6px}',
    '.close:hover{opacity:1;background:rgba(255,255,255,.14)}',
    '.log{flex:1 1 auto;overflow-y:auto;padding:16px;background:#f4f7fa;display:flex;',
      'flex-direction:column;gap:11px;scroll-behavior:smooth}',
    '.msg{max-width:88%;padding:11px 14px;border-radius:13px;font-size:.87rem;line-height:1.6;',
      'word-wrap:break-word;overflow-wrap:anywhere}',
    '.msg p{margin:0 0 8px}.msg p:last-child{margin-bottom:0}',
    '.msg h4{margin:10px 0 5px;font-size:.85rem;font-weight:700;color:#0b5d55}',
    '.msg h4:first-child{margin-top:0}',
    '.msg ul,.msg ol{margin:6px 0 8px;padding-left:20px}',
    '.msg ul:last-child,.msg ol:last-child{margin-bottom:0}',
    '.msg li{margin:3px 0;padding-left:2px}',
    '.msg li::marker{color:#0b7d70}',
    '.msg strong{font-weight:700;color:#0d2b3e}',
    '.msg code{background:#eef3f7;border-radius:4px;padding:1px 5px;font-size:.82em;font-family:ui-monospace,Menlo,monospace}',
    '.msg .reg{color:#0b7d70;font-weight:700;white-space:nowrap}',
    '.msg a{color:#0b7d70}',
    '.me strong,.me .reg,.me h4{color:#fff}',
    '.me a{color:#d6fff9}',
    '.bot{background:#fff;border:1px solid #e2e9f1;border-bottom-left-radius:4px;align-self:flex-start}',
    '.me{background:#0b7d70;color:#fff;border-bottom-right-radius:4px;align-self:flex-end}',
    '.tag{font-size:.63rem;letter-spacing:.07em;text-transform:uppercase;color:#7b8ba3;',
      'margin:-4px 0 0 3px;align-self:flex-start}',
    '.chips{display:flex;flex-wrap:wrap;gap:6px;padding:0 16px 12px;background:#f4f7fa;flex:0 0 auto}',
    '.chip{font-size:.76rem;padding:6px 11px;border-radius:99px;border:1px solid #cfdae6;',
      'background:#fff;color:#274156;cursor:pointer;font-family:inherit}',
    '.chip:hover{border-color:#0b7d70;color:#0b7d70}',
    '.foot{flex:0 0 auto;border-top:1px solid #e2e9f1;padding:10px;display:flex;gap:8px;background:#fff}',
    '.foot textarea{flex:1;border:1px solid #d7e0ea;border-radius:10px;padding:9px 11px;resize:none;',
      "font-family:inherit;font-size:.87rem;line-height:1.45;max-height:96px;color:#12263f;background:#fff}",
    '.foot textarea:focus{outline:none;border-color:#0b7d70;box-shadow:0 0 0 3px rgba(11,125,112,.13)}',
    '.send{border:none;background:#0b7d70;color:#fff;border-radius:10px;width:42px;cursor:pointer;',
      'font-size:16px;flex:0 0 auto}',
    '.send:disabled{opacity:.45;cursor:not-allowed}',
    '.typing{display:flex;gap:4px;padding:12px 14px;align-self:flex-start;background:#fff;',
      'border:1px solid #e2e9f1;border-radius:13px;border-bottom-left-radius:4px}',
    '.typing i{width:6px;height:6px;border-radius:50%;background:#9fb0c4;animation:b 1.2s infinite}',
    '.typing i:nth-child(2){animation-delay:.15s}.typing i:nth-child(3){animation-delay:.3s}',
    '@keyframes b{0%,60%,100%{opacity:.3}30%{opacity:1}}',
    '.note{font-size:.68rem;color:#8496ab;text-align:center;padding:0 16px 9px;background:#fff}',
    '@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}',
    '</style>',

    '<button class="launch" id="launch" aria-label="Open the election assistant" title="Election assistant">',
      '<span>💬</span><span class="dot"></span>',
    '</button>',

    '<section class="panel" id="panel" role="dialog" aria-label="SRC Election Assistant">',
      '<div class="head">',
        '<div class="avatar">🗳️</div>',
        '<div><h2>SRC Election Assistant</h2><p>Rules, nominations and voting</p></div>',
        '<button class="hbtn" id="restart" aria-label="Start a new chat" title="Start a new chat">⟳</button>',
        '<button class="close" id="close" aria-label="Close">×</button>',
      '</div>',
      '<div class="log" id="log" aria-live="polite"></div>',
      '<div class="chips" id="chips"></div>',
      '<div class="foot">',
        '<textarea id="input" rows="1" placeholder="Ask about the election…" aria-label="Your question"></textarea>',
        '<button class="send" id="send" aria-label="Send">➤</button>',
      '</div>',
      '<div class="note">Not sure? The Department of Student Affairs can always help.</div>',
    '</section>'
  ].join('');

  var $ = function (id) { return root.getElementById(id); };
  var panel = $('panel'), log = $('log'), input = $('input'), send = $('send'),
      launch = $('launch'), chips = $('chips');

  function save() {
    try { sessionStorage.setItem(STORE, JSON.stringify(history.slice(-20))); } catch (e) {}
  }

  /* Models answer in light markdown — **bold**, bullet lists, numbered
     steps — and rendering that as literal asterisks looks broken. This
     converts the handful of things that actually turn up. Everything is
     escaped first, so the model can never inject markup. */
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
    });
  }

  function format(text) {
    var lines = esc(text).split('\n');
    var out = [], list = null;

    function closeList() { if (list) { out.push('</' + list + '>'); list = null; } }

    lines.forEach(function (raw) {
      var line = raw.trim();
      if (!line) { closeList(); return; }

      var bullet = line.match(/^[•\-*]\s+(.*)$/);
      var numbered = line.match(/^(\d+)[.)]\s+(.*)$/);

      if (bullet) {
        if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
        out.push('<li>' + inline(bullet[1]) + '</li>');
        return;
      }
      if (numbered) {
        if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
        out.push('<li>' + inline(numbered[2]) + '</li>');
        return;
      }
      closeList();
      // A short line ending in a colon reads as a heading for what follows.
      if (/^.{3,60}:$/.test(line) && !/[.!?]$/.test(line)) out.push('<h4>' + inline(line.slice(0, -1)) + '</h4>');
      else out.push('<p>' + inline(line) + '</p>');
    });
    closeList();
    return out.join('');
  }

  function inline(s) {
    return s
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      // Regulation references are the thing students are looking for.
      .replace(/\b(Reg(?:ulation)?\.?\s?\d+(?:\([0-9a-z]+\))*)/g, '<b class="reg">$1</b>')
      .replace(/\b([\w.+-]+@[\w-]+\.[\w.]+)\b/g, '<a href="mailto:$1">$1</a>');
  }

  function bubble(text, who, tag) {
    var d = document.createElement('div');
    d.className = 'msg ' + (who === 'user' ? 'me' : 'bot');
    if (who === 'user') d.textContent = text;
    else d.innerHTML = format(text);
    log.appendChild(d);
    if (tag) {
      var t = document.createElement('div');
      t.className = 'tag';
      t.textContent = tag;
      log.appendChild(t);
    }
    log.scrollTop = log.scrollHeight;
  }

  function renderChips() {
    chips.innerHTML = '';
    if (history.length) return;              // only on a fresh conversation
    SUGGESTIONS.forEach(function (s) {
      var b = document.createElement('button');
      b.className = 'chip';
      b.textContent = s;
      b.addEventListener('click', function () { input.value = s; ask(); });
      chips.appendChild(b);
    });
  }

  function greet() {
    bubble(
      'Hello! I can help with the SRC election — who may vote, who may stand, how nominations and endorsements work, ' +
      'linking your MetaMask wallet, and how voting works.\n\nWhat would you like to know?', 'bot');
  }

  history.forEach(function (m) { bubble(m.content, m.role === 'user' ? 'user' : 'bot'); });
  if (!history.length) greet();
  renderChips();

  // Bumped on every restart. A reply that arrives after the student has
  // started a new chat belongs to a conversation that no longer exists,
  // so it is dropped rather than appended to the fresh one.
  var generation = 0;

  var busy = false;
  async function ask() {
    var q = input.value.trim();
    if (!q || busy) return;
    var era = generation;
    busy = true; send.disabled = true;
    input.value = ''; input.style.height = 'auto';
    bubble(q, 'user');
    history.push({ role: 'user', content: q });
    chips.innerHTML = '';

    var typing = document.createElement('div');
    typing.className = 'typing';
    typing.innerHTML = '<i></i><i></i><i></i>';
    log.appendChild(typing);
    log.scrollTop = log.scrollHeight;

    try {
      var res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: q, history: history.slice(-6, -1) })
      });
      var data = await res.json();
      typing.remove();
      if (era !== generation) return;          // the chat was restarted while we waited
      var answer = data.answer || data.error || 'Something went wrong. Please try again.';
      // Say when a reply came from the built-in answers rather than the
      // model, so nobody mistakes a fallback for a live one.
      var tag = (data.source === 'faq' || data.source === 'faq-fallback') ? 'From the election FAQ'
              : (data.source === 'fallback' || data.source === 'disabled') ? 'Referred to the DSA' : '';
      bubble(answer, 'bot', tag);
      history.push({ role: 'assistant', content: answer });
      save();
    } catch (e) {
      typing.remove();
      if (era === generation) {
        bubble('I could not reach the assistant just now. Please check your connection, or contact the Department of ' +
               'Student Affairs on (+6016) 210-0864 or dsa@utar.edu.my.', 'bot');
      }
    } finally {
      busy = false; send.disabled = false; input.focus();
    }
  }

  send.addEventListener('click', ask);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); }
  });
  input.addEventListener('input', function () {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 96) + 'px';
  });

  function open() {
    panel.classList.add('open');
    launch.classList.remove('unread');
    setTimeout(function () { input.focus(); }, 60);
  }
  function close() { panel.classList.remove('open'); }

  /* Start over. A student who has wandered off topic, or is handing the
     screen to a friend, should not have to scroll past someone else's
     conversation — and clearing it also drops the history sent to the
     model, so the next answer starts clean. */
  function restart() {
    generation++;
    busy = false; send.disabled = false;
    history = [];
    try { sessionStorage.removeItem(STORE); } catch (e) {}
    log.innerHTML = '';
    greet();
    renderChips();
    input.value = '';
    input.style.height = 'auto';
    input.focus();
  }

  root.getElementById('restart').addEventListener('click', restart);

  launch.addEventListener('click', function () {
    panel.classList.contains('open') ? close() : open();
  });
  $('close').addEventListener('click', close);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && panel.classList.contains('open')) close();
  });
})();
