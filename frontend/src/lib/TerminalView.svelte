<script>
  import { onMount, onDestroy } from 'svelte';
  import Icon from './Icon.svelte';
  import { Terminal } from 'xterm';
  import { FitAddon } from '@xterm/addon-fit';
  import 'xterm/css/xterm.css';
  export let apps = [], initialApp = '', onOpenLogs = null;
  let terms = [], activeId = null, newApp = '', termErr = '';
  let outMap = {}, seenMap = {}, poll = null, resizeTimer = null;
  let termEl = null, xterm = null, fitAddon = null;
  let ctrlSticky = false, altSticky = false;
  // Zoom tampilan terminal (ukuran font): 50% paling kecil (tulisan kecil, QR lebih rapat),
  // 200% paling besar. Disimpan di localStorage supaya tetap setelah refresh.
  let termZoom = 100;
  try { const saved = parseInt(localStorage.getItem('controlpetro-term-zoom') || '100', 10); if ([50, 75, 100, 125, 175, 200].includes(saved)) termZoom = saved; } catch {}
  function applyZoom() {
    try { localStorage.setItem('controlpetro-term-zoom', String(termZoom)); } catch {}
    if (!xterm) return;
    try { xterm.options.fontSize = Math.round(13 * termZoom / 100); } catch {}
    try { if (fitAddon) fitAddon.fit(); } catch {}
  }
  // Layar penuh: sembunyikan topbar + bottom bar, terminal penuhi layar.
  // Dipakai buat scan QR: QR jadi sebesar mungkin, gampang di-scan HP lain.
  let termFullscreen = false;
  function toggleFullscreen() {
    termFullscreen = !termFullscreen;
    try { document.body.classList.toggle('term-fullscreen', termFullscreen); } catch {}
    setTimeout(() => { try { if (fitAddon) fitAddon.fit(); } catch {} }, 80);
  }
  $: active = terms.find((t) => t.id === activeId) || null;
  $: activeApp = active && active.app ? (apps.find((a) => a.name === active.app) || null) : null;
  async function api(p, opt) {
    const r = await fetch(p, Object.assign({ credentials: 'same-origin' }, opt || {}));
    if (r.status === 401) { window.location.href = '/login'; throw new Error('auth'); }
    return r;
  }
  function xtermTheme() {
    const dark = document.documentElement.dataset.theme !== 'light';
    return dark
      ? { background: '#0A0A0C', foreground: '#F5F5F7', cursor: '#F5F5F7', cursorAccent: '#0A0A0C', selectionBackground: 'rgba(10,132,255,.35)', black: '#0A0A0C', red: '#FF453A', green: '#30D158', yellow: '#FFD60A', blue: '#0A84FF', magenta: '#BF5AF2', cyan: '#64D2FF', white: '#F5F5F7', brightBlack: '#636366', brightRed: '#FF6961', brightGreen: '#30D158', brightYellow: '#FFD60A', brightBlue: '#64A7FF', brightMagenta: '#DA8FFF', brightCyan: '#64D2FF', brightWhite: '#FFFFFF' }
      : { background: '#FFFFFF', foreground: '#1C1C1E', cursor: '#1C1C1E', cursorAccent: '#FFFFFF', selectionBackground: 'rgba(10,132,255,.25)', black: '#1C1C1E', red: '#D70015', green: '#248A3D', yellow: '#9E6B00', blue: '#0071E3', magenta: '#AF52DE', cyan: '#008299', white: '#F5F5F7', brightBlack: '#636366', brightRed: '#D70015', brightGreen: '#248A3D', brightYellow: '#9E6B00', brightBlue: '#0071E3', brightMagenta: '#AF52DE', brightCyan: '#008299', brightWhite: '#1C1C1E' };
  }
  function initXterm() {
    if (xterm) return;
    xterm = new Terminal({ cursorBlink: true, cursorStyle: 'block', fontFamily: 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace', fontSize: Math.round(13 * termZoom / 100), lineHeight: 1.0, scrollback: 2000, convertEol: true, theme: xtermTheme(), allowProposedApi: true });
    fitAddon = new FitAddon();
    xterm.loadAddon(fitAddon);
    xterm.open(termEl);
    try { fitAddon.fit(); } catch {}
    xterm.onData((data) => { sendRaw(transformSticky(data)); });
    xterm.onResize((dims) => {
      if (!activeId) return;
      api('/api/term/' + activeId + '/resize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cols: dims.cols, rows: dims.rows }) }).catch(() => {});
    });
    if (termEl) termEl.addEventListener('click', () => { try { xterm.focus(); } catch {} });
  }
  function transformSticky(data) {
    if (!ctrlSticky && !altSticky) return data;
    let out = data;
    if (ctrlSticky && /^[a-zA-Z]$/.test(data)) out = String.fromCharCode(data.toLowerCase().charCodeAt(0) - 96);
    else if (ctrlSticky && data === ' ') out = '\x00';
    if (altSticky) out = '\x1b' + out;
    ctrlSticky = false; altSticky = false;
    return out;
  }
  async function sendRaw(data) {
    if (!activeId || !data) return;
    try { await api('/api/term/' + activeId + '/input', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: data }) }); } catch {}
  }
  function sendToolbar(seq) { sendRaw(seq); try { xterm.focus(); } catch {} }
  async function loadList() {
    try {
      const r = await api('/api/term/list');
      const j = await r.json();
      terms = j.terms || [];
      for (const t of terms) { if (!(t.id in outMap)) { outMap[t.id] = ''; seenMap[t.id] = 0; } }
      for (const id of Object.keys(outMap)) { if (!terms.some((t) => t.id === id) && id !== activeId) { delete outMap[id]; delete seenMap[id]; } }
      if (!activeId && terms.length) activeId = terms[0].id;
      if (activeId && !terms.some((t) => t.id === activeId)) activeId = terms.length ? terms[0].id : null;
    } catch {}
  }
  async function catchUp(id) {
    if (!id) return;
    try {
      const r = await api('/api/term/' + id + '/output?since=' + (seenMap[id] || 0));
      const j = await r.json();
      if (j.output) { outMap[id] = (outMap[id] || '') + j.output; seenMap[id] = j.next; }
    } catch {}
  }
  async function renderActive() {
    if (!xterm || !activeId) return;
    await catchUp(activeId);
    xterm.clear();
    const full = outMap[activeId] || '';
    if (full) xterm.write(full);
    xterm.scrollToBottom();
    try { fitAddon.fit(); } catch {}
  }
  async function switchTo(id) { activeId = id; await renderActive(); }
  async function openNew(appName) {
    try {
      const r = await api('/api/term', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app: appName || '' }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'Gagal membuka terminal');
      outMap[j.id] = ''; seenMap[j.id] = 0;
      await loadList();
      await switchTo(j.id);
    } catch (e) { termErr = e.message; }
  }
  async function openTermForApp(appName) {
    if (!appName) return;
    const existing = terms.find((t) => t.app === appName);
    if (existing) { await switchTo(existing.id); return; }
    await openNew(appName);
  }
  async function closeTerm(id) {
    try { await api('/api/term/' + id, { method: 'DELETE' }); } catch {}
    delete outMap[id]; delete seenMap[id];
    const wasActive = activeId === id;
    await loadList();
    if (wasActive) { if (terms.length) await switchTo(terms[0].id); else { activeId = null; if (xterm) xterm.clear(); } }
  }
  async function pollFn() {
    if (!activeId || !xterm) return;
    try {
      const r = await api('/api/term/' + activeId + '/output?since=' + (seenMap[activeId] || 0));
      const j = await r.json();
      if (j.output) { outMap[activeId] = (outMap[activeId] || '') + j.output; seenMap[activeId] = j.next; xterm.write(j.output); xterm.scrollToBottom(); }
    } catch {}
  }
  function labelOf(t) { return t.app ? t.app : 'Utama'; }
  function cwdShort(t) {
    if (!t.cwd) return '';
    const i = t.cwd.indexOf('/v3/');
    return i >= 0 ? t.cwd.slice(i + 1) : t.cwd;
  }
  function onWinResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { try { if (xterm && fitAddon) fitAddon.fit(); } catch {} }, 120);
  }
  onMount(async () => {
    initXterm();
    await loadList();
    if (initialApp) await openTermForApp(initialApp);
    else if (!terms.length) await openNew('');
    else await renderActive();
    poll = setInterval(pollFn, 700);
    window.addEventListener('resize', onWinResize);
  });
  onDestroy(() => { if (poll) clearInterval(poll); window.removeEventListener('resize', onWinResize); try { if (xterm) xterm.dispose(); } catch {} xterm = null; });
</script>

<div class="anim-slide-up termview" class:fullscreen={termFullscreen}>
  <h2 class="title">Terminal</h2>
  <p class="sub">Terminal interaktif ala Termux. Ketik langsung di dalam terminal, kursor jalan, Ctrl+C / panah / history jalan. Tiap app punya terminalnya sendiri (shell di folder app).</p>

  <div class="termbar">
    {#each terms as t}
      <button class="termchip" class:active={t.id === activeId} on:click={() => switchTo(t.id)}>
        <span class="dot {t.app ? 'app' : 'main'}"></span> {labelOf(t)}
        <span class="chipx" role="button" tabindex="0" title="Tutup terminal" on:click|stopPropagation={() => closeTerm(t.id)} on:keydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); closeTerm(t.id); } }}>×</span>
      </button>
    {/each}
    <button class="btn small" on:click={() => openNew('')}><Icon name="plus" size={14} /> Terminal Utama</button>
    <span class="newapp">
      <select bind:value={newApp}><option value="">Terminal App...</option>{#each apps as a}<option value={a.name}>{a.name}</option>{/each}</select>
      <button class="btn small primary" disabled={!newApp} on:click={() => { const v = newApp; newApp = ''; openTermForApp(v); }}>Buka</button>
    </span>
  </div>

  {#if active}
    <div class="termhead">
      <span class="termlabel"><Icon name="terminal" size={16} /> {labelOf(active)} <small>{cwdShort(active)}{active.pty === false ? ' · tanpa PTY' : ''}</small></span>
      {#if activeApp}<span class="pill"><span class="dot {activeApp.status}"></span>{activeApp.status}</span>{/if}
      {#if active.app}<button class="btn small" on:click={() => onOpenLogs && onOpenLogs(active.app)}><Icon name="logs" size={14} /> Lihat Log</button>{/if}
      <label class="zoomlabel" title="Ukuran tampilan terminal">Zoom
        <select bind:value={termZoom} on:change={applyZoom}>
          <option value={50}>50%</option>
          <option value={75}>75%</option>
          <option value={100}>100%</option>
          <option value={125}>125%</option>
          <option value={175}>175%</option>
          <option value={200}>200%</option>
        </select>
      </label>
      <button class="btn small" title="Layar penuh (buat scan QR)" on:click={toggleFullscreen}><Icon name="open" size={14} /> {termFullscreen ? 'Keluar' : 'Layar Penuh'}</button>
    </div>
  {/if}

  <div class="xterm-wrap glass" bind:this={termEl}></div>

  <!-- Toolbar ala Termux -->
  <div class="termuxbar" aria-label="Tombol terminal">
    <button class="tb" class:on={ctrlSticky} title="CTRL (tempel, berlaku untuk tombol berikutnya)" on:click={() => { ctrlSticky = !ctrlSticky; }}>CTRL</button>
    <button class="tb" class:on={altSticky} title="ALT (tempel, berlaku untuk tombol berikutnya)" on:click={() => { altSticky = !altSticky; }}>ALT</button>
    <button class="tb" title="ESC" on:click={() => sendToolbar('\x1b')}>ESC</button>
    <button class="tb" title="Tab" on:click={() => sendToolbar('\t')}>TAB</button>
    <button class="tb" title="Panah atas (history)" on:click={() => sendToolbar('\x1b[A')}>↑</button>
    <button class="tb" title="Panah bawah" on:click={() => sendToolbar('\x1b[B')}>↓</button>
    <button class="tb" title="Panah kiri" on:click={() => sendToolbar('\x1b[D')}>←</button>
    <button class="tb" title="Panah kanan" on:click={() => sendToolbar('\x1b[C')}>→</button>
    <button class="tb danger" title="Ctrl+C (batalkan perintah)" on:click={() => sendToolbar('\x03')}>Ctrl+C</button>
    <button class="tb" title="Ctrl+L (bersihkan layar)" on:click={() => sendToolbar('\x0c')}>Ctrl+L</button>
    <button class="tb" title="Ctrl+D (EOF / keluar)" on:click={() => sendToolbar('\x04')}>Ctrl+D</button>
    <button class="tb" title="Buka keyboard HP" on:click={() => { try { xterm.focus(); } catch {} }}>Keyboard</button>
  </div>
  {#if ctrlSticky || altSticky}<p class="stickynote">{ctrlSticky ? 'CTRL aktif — ketik 1 tombol berikutnya (misal C jadi Ctrl+C). ' : ''}{altSticky ? 'ALT aktif — tombol berikutnya dikirim dengan ALT.' : ''}</p>{/if}

  {#if termErr}<p class="stickynote" style="color:#FF3B30">{termErr}</p>{/if}
  {#if !active}<div class="card" style="margin-top:12px"><p>Belum ada terminal. Buka Terminal Utama atau pilih app di atas.</p></div>{/if}
</div>

<style>
  .title{font-size:24px;letter-spacing:-.02em;margin:4px 0 4px}
  .sub{color:var(--muted);font-size:14px;margin:0 0 16px}
  .termbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px}
  .termchip{display:inline-flex;gap:6px;align-items:center;border:1px solid var(--border);background:var(--card);color:var(--text);border-radius:99px;padding:7px 8px 7px 12px;font-size:13px;font-weight:600;cursor:pointer}
  .termchip.active{background:var(--text);color:var(--bg);border-color:var(--text)}
  .termchip .dot{width:8px;height:8px;border-radius:99px;background:var(--muted);flex:none}
  .termchip .dot.app{background:#34C759}
  .termchip .dot.main{background:#0A84FF}
  .chipx{width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;border-radius:99px;font-size:15px;line-height:1;opacity:.7}
  .chipx:hover{background:rgba(255,59,48,.2);color:#FF3B30;opacity:1}
  .newapp{display:inline-flex;gap:6px;align-items:center}
  .newapp select{max-width:170px}
  .termhead{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px}
  .termlabel{display:inline-flex;gap:6px;align-items:center;font-weight:700}
  .termlabel small{font-weight:400;color:var(--muted)}
  .zoomlabel{display:inline-flex;gap:6px;align-items:center;font-size:13px;font-weight:600;color:var(--muted);margin-left:auto}
  .zoomlabel select{max-width:90px;padding:6px 8px;border-radius:10px;border:1px solid var(--border);background:var(--card);color:var(--text);font-size:13px;font-weight:700}
  .pill{display:inline-flex;gap:6px;align-items:center}
  .termview{padding:0 8px}
  .termview.fullscreen{position:fixed;inset:0;z-index:100;padding:8px;background:#0A0A0C}
  .termview.fullscreen .xterm-wrap{width:100%;margin-left:0;margin-right:0;min-height:calc(100vh - 140px)}
  :global(body.term-fullscreen .topbar), :global(body.term-fullscreen .bottombar), :global(body.term-fullscreen .sidebar){display:none!important}
  .xterm-wrap{border:none;border-radius:0;padding:2px;min-height:340px;overflow:hidden;width:calc(100% + 16px);margin-left:-8px;margin-right:-8px;box-sizing:border-box;background:#0A0A0C}
  :global([data-theme="light"]) .xterm-wrap{background:#FFFFFF}
  .xterm-wrap :global(.xterm){height:100%}
  .xterm-wrap :global(.xterm-viewport){overflow-y:auto}
  .termuxbar{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;padding:8px;border:1px solid var(--border);border-radius:14px;background:var(--glass-bg);-webkit-backdrop-filter:blur(16px) saturate(160%);backdrop-filter:blur(16px) saturate(160%)}
  .tb{min-width:44px;padding:8px 10px;border-radius:10px;border:1px solid var(--border);background:var(--card);color:var(--text);font-size:13px;font-weight:700;cursor:pointer}
  .tb:active{transform:scale(.94)}
  .tb.on{background:var(--text);color:var(--bg);border-color:var(--text)}
  .tb.danger{color:#FF3B30}
  .stickynote{color:var(--muted);font-size:12px;margin:6px 0 0}
  .row{display:flex;gap:8px;margin-top:10px}
  .row .btn{display:inline-flex;gap:6px;align-items:center;flex:none}
</style>
