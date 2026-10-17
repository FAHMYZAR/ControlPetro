<script>
  import { onMount } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import Icon from './lib/Icon.svelte';
  import Login from './lib/Login.svelte';
  import Home from './lib/Home.svelte';
  import Apps from './lib/Apps.svelte';
  import TerminalView from './lib/TerminalView.svelte';
  import Logs from './lib/Logs.svelte';
  import Settings from './lib/Settings.svelte';
  import BottomSheet from './lib/BottomSheet.svelte';
  import BackupSheet from './lib/BackupSheet.svelte';
  import FileManager from './lib/FileManager.svelte';
  import Domain from './lib/Domain.svelte';

  const NAV = [
    { id: 'home', label: 'Beranda', icon: 'home' },
    { id: 'apps', label: 'Aplikasi', icon: 'apps' },
    { id: 'domain', label: 'Domain', icon: 'network' },
    { id: 'terminal', label: 'Terminal', icon: 'terminal' },
    { id: 'logs', label: 'Log', icon: 'logs' },
    { id: 'files', label: 'File', icon: 'folder' },
    { id: 'settings', label: 'Pengaturan', icon: 'settings' },
  ];
  let authed = null, user = '', view = 'home', drawer = false, sheet = false, editApp = null, apps = [], stats = null, cfg = null, focusApp = '', toast = '', toastTimer = null, theme = localStorage.getItem('bridge-theme') || 'auto', refreshing = false;
  function openSheetFor(nm) { editApp = nm; sheet = true; }
  function closeSheet() { sheet = false; editApp = null; }
  let filePath = 'apps', fileNonce = 0;
  function openFiles(path) { filePath = path || 'apps'; fileNonce += 1; go('files'); }
  let termTargetApp = '';
  function openTerm(name) { termTargetApp = name || ''; view = 'terminal'; drawer = false; location.hash = 'terminal'; }

  function showToast(m) { toast = m; clearTimeout(toastTimer); toastTimer = setTimeout(() => toast = '', 2600); }
  function applyTheme() {
    const eff = theme === 'auto' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : theme;
    document.documentElement.dataset.theme = eff;
  }
  function setTheme(t) { theme = t; localStorage.setItem('bridge-theme', t); applyTheme(); }
  function cycleTheme() { setTheme(theme === 'light' ? 'dark' : theme === 'dark' ? 'auto' : 'light'); showToast('Tema: ' + theme); }

  async function api(p, opt) {
    const o = Object.assign({ credentials: 'same-origin' }, opt || {});
    // Body JSON (string) harus dikirim dengan Content-Type application/json,
    // kalau tidak express.json() di server tidak parse body-nya dan req.body jadi {}.
    // (Inilah penyebab "public harus boolean": body {"public":true} tidak ke-parse.)
    if (o.body && typeof o.body === 'string') {
      o.headers = Object.assign({ 'Content-Type': 'application/json' }, o.headers || {});
    }
    const r = await fetch(p, o);
    if (r.status === 401) { authed = false; throw new Error('auth'); }
    return r;
  }
  async function loadApps() {
    try { const r = await api('/api/apps'); const j = await r.json(); apps = j.apps || []; } catch {}
  }
  async function loadStats() {
    try { const r = await api('/api/stats'); stats = await r.json(); if (stats.apps) apps = stats.apps; } catch {}
  }
  async function loadCfg() {
    try { const r = await api('/api/config'); cfg = await r.json(); } catch {}
  }
  let backupSheet = false;
  async function refreshAll() { refreshing = true; await Promise.all([loadStats(), loadCfg()]); refreshing = false; showToast('Dimuat ulang'); }
  async function act(name, action) {
    await api('/api/apps/' + name + '/' + action, { method: 'POST' });
    showToast(action + ' ' + name); setTimeout(loadApps, 900);
  }
  async function togglePublic(name, val) {
    try {
      const r = await api('/api/apps/' + encodeURIComponent(name) + '/public', { method: 'POST', body: JSON.stringify({ public: val }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'gagal');
      showToast(name + (val ? ' jadi Publik' : ' jadi Private')); loadApps();
    } catch (e) { showToast('Gagal ubah: ' + e.message); }
  }
  function go(v) { if (v === 'terminal') termTargetApp = ''; view = v; drawer = false; location.hash = v; if (v === 'home') loadStats(); if (v === 'apps') loadApps(); if (v === 'settings') loadCfg(); }
  function openLogs(name) { focusApp = name; go('logs'); }
  async function deleteApp(name) {
    if (!window.confirm('Hapus app ' + name + ' beserta seluruh foldernya? Tindakan ini tidak bisa dibatalkan.')) return;
    try {
      const r = await api('/api/apps/' + encodeURIComponent(name), { method: 'DELETE' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'Gagal menghapus app');
      showToast('App ' + name + ' dihapus');
      await Promise.all([loadApps(), loadStats()]);
    } catch (e) { showToast('Gagal hapus: ' + e.message); }
  }

  async function logout() {
    try { await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }); } catch {}
    // Clear any client state, force hard navigation with cache-busting so a cached dashboard can never reappear
    apps = []; stats = null; cfg = null; authed = false; user = '';
    window.location.replace('/login?v=' + Date.now());
  }
  async function checkMe() {
    try {
      const r = await fetch('/api/me', { credentials: 'same-origin' });
      if (!r.ok) { authed = false; return; }
      const j = await r.json(); user = j.user; authed = true;
      const start = location.hash.replace('#', '') || 'home';
      if (NAV.some(n => n.id === start)) view = start;
      await Promise.all([loadStats(), loadCfg()]);
    } catch { authed = false; }
  }
  onMount(() => { applyTheme(); checkMe(); });
</script>

{#if authed === null}
  <div class="center">Memuat...</div>
{:else if !authed}
  <Login onLogin={() => { authed = true; checkMe(); }} />
{:else}
  <header class="topbar topbar-glass">
    <button class="iconbtn hamburger" on:click={() => drawer = true} aria-label="Menu"><Icon name="menu" size={20} /></button>
    <img class="brand-img" src="/logo.png" alt="ControlPetro" />
    <h1>ControlPetro</h1>
    <span class="sp"></span>
    <button class="iconbtn" on:click={cycleTheme} title="Ganti tema"><Icon name="moon" size={20} /></button>
    <button class="iconbtn" on:click={logout} title="Keluar"><Icon name="logout" size={20} /></button>
  </header>
  {#if drawer}
    <div class="drawer-bg" transition:fade={{ duration: 180 }} on:click={() => drawer = false}></div>
    <aside class="drawer drawer-glass" transition:fly={{ x: -280, duration: 260 }}>
      <div class="drawer-brand"><img class="brand-img" src="/logo.png" alt="ControlPetro" /><h2>ControlPetro</h2></div>
      <nav>
        {#each NAV as n}<button class="navbtn" class:active={view === n.id} on:click={() => go(n.id)}><Icon name={n.icon} size={22} /> {n.label}</button>{/each}
      </nav>
    </aside>
  {/if}
  <div class="layout">
    <aside class="sidebar drawer-glass">
      <nav>
        {#each NAV as n}<button class="navbtn" class:active={view === n.id} on:click={() => go(n.id)}><Icon name={n.icon} size={22} /> {n.label}</button>{/each}
      </nav>
      <div class="card sidecard"><h3>Server</h3><p>botapaya · Pterodactyl</p><p class="muted2">{stats ? 'RAM ' + Math.round((1 - stats.mem.free / stats.mem.total) * 100) + '% · ' + stats.apps.length + ' app' : 'Memuat...'}</p></div>
    </aside>
    <main class:wide={view === 'terminal'}>
      {#key view}
        <div class="anim-fade">
          {#if view === 'home'}<Home {apps} {stats} onAct={act} onOpenSheet={() => openSheetFor(null)} onOpenLogs={openLogs} onOpenFiles={openFiles} onRefresh={refreshAll} onDelete={deleteApp} onSetup={openSheetFor} onOpenTerm={openTerm} onTogglePublic={togglePublic} />{/if}
          {#if view === 'apps'}<Apps {apps} onAct={act} onOpenSheet={() => openSheetFor(null)} onOpenLogs={openLogs} onOpenFiles={openFiles} onDelete={deleteApp} onSetup={openSheetFor} onOpenTerm={openTerm} onTogglePublic={togglePublic} />{/if}
          {#if view === 'terminal'}<TerminalView {apps} initialApp={termTargetApp} onOpenLogs={openLogs} />{/if}
          {#if view === 'logs'}<Logs {apps} focusApp={focusApp} />{/if}
          {#if view === 'files'}{#key fileNonce}<FileManager initialPath={filePath} onToast={showToast} />{/key}{/if}
          {#if view === 'domain'}<Domain />{/if}
          {#if view === 'settings'}<Settings {theme} onTheme={setTheme} me={user} {cfg} onLogout={logout} onOpenBackup={() => backupSheet = true} />{/if}
        </div>
      {/key}
    </main>
  </div>
  <nav class="bottombar bottombar-glass">
    {#each NAV as n}<button class="bottomtab" class:active={view === n.id} on:click={() => go(n.id)}><Icon name={n.icon} size={20} />{n.label}</button>{/each}
  </nav>
  <BottomSheet open={sheet} {apps} editApp={editApp} onClose={closeSheet} onCreated={(nm) => { showToast('App ' + nm + ' dibuat'); loadApps(); go('apps'); }} />
  <BackupSheet open={backupSheet} onClose={() => backupSheet = false} />
  {#if toast}<div class="toast">{toast}</div>{/if}
{/if}

<style>
  .center{display:flex;align-items:center;justify-content:center;height:100vh;color:var(--muted)}
  .topbar{position:sticky;top:0;z-index:30;display:flex;align-items:center;gap:12px;padding:12px 16px}
  .topbar h1{font-size:18px;margin:0;letter-spacing:-.02em}
  .brand-img{width:32px;height:32px;border-radius:9px;object-fit:cover;flex:none}
  .drawer-brand{display:flex;gap:10px;align-items:center;margin:8px 0 16px}
  .drawer-brand h2{margin:0}
  .sp{flex:1}
  .hamburger{display:flex}
  @media(min-width:900px){.hamburger{display:none!important}}
  .drawer-bg{position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:45}
  .drawer{position:fixed;left:0;top:0;bottom:0;width:280px;z-index:46;padding:16px}
  .drawer h2{margin:8px 0 16px}
  .drawer nav{display:flex;flex-direction:column;gap:6px}
  .layout{display:flex}
  .sidebar{width:276px;min-height:calc(100vh - 63px);padding:16px;position:sticky;top:63px;display:none}
  @media(min-width:900px){.sidebar{display:block}}
  .sidebar nav{display:flex;flex-direction:column;gap:6px}
  .sidecard{margin-top:20px}
  .sidecard h3{margin:0 0 6px;font-size:16px}
  .sidecard p{margin:0;color:var(--muted);font-size:13px}
  .sidecard .muted2{margin-top:8px}
  main{flex:1;padding:20px;max-width:980px;margin:0 auto;width:100%;padding-bottom:110px}
  main.wide{max-width:none;padding-left:0;padding-right:0}
  @media(min-width:900px){main{padding-bottom:32px}}
  .bottombar{position:fixed;left:0;right:0;bottom:0;z-index:40;display:flex;gap:2px;padding:8px 6px calc(8px + env(safe-area-inset-bottom))}
  .bottombar :global(.bottomtab){font-size:10px;padding:6px 1px}
  @media(min-width:900px){.bottombar{display:none!important}}
</style>
