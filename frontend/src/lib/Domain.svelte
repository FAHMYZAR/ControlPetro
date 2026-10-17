<script>
  import { onMount } from 'svelte';
  import Icon from './Icon.svelte';

  let domain = null, loading = true;
  let err = '';
  let busy = ''; // 'connect' | 'setup' | 'restart' | 'disconnect' | 'status'
  let apiToken = '', zones = [], zoneId = '', subdomain = '';
  let showSetup = false; // form pilih zone + subdomain sesudah connect sukses
  let showConnect = false; // form hubungkan (awal, atau ganti domain)

  async function loadStatus() {
    busy = 'status';
    try {
      const r = await fetch('/api/domain/status', { credentials: 'same-origin' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'gagal memuat status domain');
      domain = d.domain || null;
    } catch (e) { err = e.message; }
    busy = ''; loading = false;
  }

  async function connect() {
    if (!apiToken.trim()) { err = 'API token wajib diisi.'; return; }
    err = ''; busy = 'connect';
    try {
      const r = await fetch('/api/domain/connect', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiToken: apiToken.trim() }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'gagal hubungkan Cloudflare');
      zones = d.zones || [];
      zoneId = zones.length ? zones[0].id : '';
      showSetup = true; showConnect = false;
    } catch (e) { err = e.message; }
    busy = '';
  }

  function validSubdomain(s) { return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(s); }

  async function setup() {
    if (!zoneId) { err = 'Pilih zone dulu.'; return; }
    if (!validSubdomain(subdomain.trim().toLowerCase())) { err = 'Subdomain tidak valid. Pakai huruf kecil, angka, dan dash, tanpa spasi. Contoh: srv9'; return; }
    err = ''; busy = 'setup';
    try {
      const r = await fetch('/api/domain/setup', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ zoneId, subdomain: subdomain.trim().toLowerCase() }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'gagal pasang domain');
      showSetup = false; showConnect = false; subdomain = ''; apiToken = '';
      await loadStatus();
    } catch (e) { err = e.message; }
    busy = '';
  }

  async function restart() {
    err = ''; busy = 'restart';
    try {
      const r = await fetch('/api/domain/restart', { method: 'POST', credentials: 'same-origin' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'gagal restart tunnel');
      await loadStatus();
    } catch (e) { err = e.message; }
    busy = '';
  }

  async function disconnect() {
    const host = domain && domain.hostname ? domain.hostname : 'domain ini';
    if (!window.confirm('Putuskan domain ' + host + '? Tunnel + DNS akan dihapus dari Cloudflare.')) return;
    err = ''; busy = 'disconnect';
    try {
      const r = await fetch('/api/domain/disconnect', { method: 'POST', credentials: 'same-origin' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'gagal putuskan domain');
      showSetup = false; showConnect = false; subdomain = ''; apiToken = '';
      await loadStatus();
    } catch (e) { err = e.message; }
    busy = '';
  }

  function startChange() { showConnect = true; showSetup = false; err = ''; }

  $: dotClass = domain ? (domain.status === 'running' ? 'running' : domain.status === 'starting' || domain.status === 'restarting' ? 'restarting' : domain.status === 'crashed' ? 'crashed' : 'stopped') : 'stopped';
  $: connected = !!(domain && domain.connected);

  onMount(loadStatus);
</script>

<div class="anim-slide-up">
  <h2 class="title">Domain</h2>
  <p class="sub">Domain publik untuk ControlPetro lewat Cloudflare Tunnel.</p>

  {#if loading}
    <div class="card"><p class="muted2">Memuat status domain...</p></div>
  {:else if connected}
    <div class="card">
      <div class="row1"><b class="hostname">{domain.hostname}</b><span class="pill"><span class="dot {dotClass}"></span>{domain.status}</span></div>
      {#if domain.tunnelId}<p class="muted2">Tunnel: <code>{domain.tunnelId}</code>{#if domain.tunnelName} · {domain.tunnelName}{/if}</p>{/if}
      <div class="rowbtn" style="margin-top:14px">
        <button class="btn small" disabled={busy !== ''} on:click={restart}><Icon name="refresh" size={14} /> {busy === 'restart' ? 'Memproses...' : 'Restart Tunnel'}</button>
        <button class="btn small" disabled={busy !== ''} on:click={startChange}><Icon name="edit" size={14} /> Ganti Domain</button>
        <button class="btn small danger" disabled={busy !== ''} on:click={disconnect}><Icon name="close" size={14} /> {busy === 'disconnect' ? 'Memproses...' : 'Putuskan'}</button>
      </div>
      {#if showConnect}
        <p class="muted2" style="margin-top:16px">Paste ulang API token untuk ganti domain.</p>
        <label class="lbl">API Token Cloudflare</label>
        <input type="password" placeholder="Paste API token Cloudflare" bind:value={apiToken} />
        <p class="muted2">Izin yang dibutuhkan: Tunnel Edit, DNS Edit, Zone Read, Account Read. <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noreferrer">Buat token di dashboard Cloudflare</a></p>
        {#if err}<p class="err">{err}</p>{/if}
        <button class="btn primary" style="margin-top:10px" disabled={busy !== ''} on:click={connect}>{busy === 'connect' ? 'Memproses...' : 'Hubungkan'}</button>
      {/if}
      {#if showSetup}
        <label class="lbl" style="margin-top:16px">Zone</label>
        <select bind:value={zoneId}>
          {#each zones as z}<option value={z.id}>{z.name}</option>{/each}
        </select>
        <label class="lbl">Subdomain</label>
        <input placeholder="contoh: srv9" bind:value={subdomain} />
        {#if err}<p class="err">{err}</p>{/if}
        <button class="btn primary" style="margin-top:10px" disabled={busy !== ''} on:click={setup}>{busy === 'setup' ? 'Memproses...' : 'Pasang Domain'}</button>
      {/if}
      {#if !showConnect && !showSetup && err}<p class="err">{err}</p>{/if}
    </div>
  {:else}
    <div class="card">
      <p class="muted2">Belum ada domain.</p>
      {#if !showSetup}
        <label class="lbl">API Token Cloudflare</label>
        <input type="password" placeholder="Paste API token Cloudflare" bind:value={apiToken} />
        <p class="muted2">Izin yang dibutuhkan: Tunnel Edit, DNS Edit, Zone Read, Account Read. <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noreferrer">Buat token di dashboard Cloudflare</a></p>
        {#if err}<p class="err">{err}</p>{/if}
        <button class="btn primary" style="margin-top:10px" disabled={busy !== ''} on:click={connect}>{busy === 'connect' ? 'Memproses...' : 'Hubungkan'}</button>
      {/if}
      {#if showSetup}
        <label class="lbl" style="margin-top:16px">Zone</label>
        <select bind:value={zoneId}>
          {#each zones as z}<option value={z.id}>{z.name}</option>{/each}
        </select>
        <label class="lbl">Subdomain</label>
        <input placeholder="contoh: srv9" bind:value={subdomain} />
        {#if err}<p class="err">{err}</p>{/if}
        <button class="btn primary" style="margin-top:10px" disabled={busy !== ''} on:click={setup}>{busy === 'setup' ? 'Memproses...' : 'Pasang Domain'}</button>
      {/if}
    </div>
  {/if}

  <div class="card" style="margin-top:14px">
    <div class="row1"><h3>Log Tunnel</h3><button class="btn small" disabled={busy !== ''} on:click={loadStatus}><Icon name="refresh" size={14} /> Refresh Status</button></div>
    <pre class="logbox">{domain && domain.logs && domain.logs.length ? domain.logs.join('\n') : 'Belum ada log.'}</pre>
  </div>
</div>

<style>
  .title{font-size:24px;letter-spacing:-.02em;margin:4px 0 4px}
  .sub{color:var(--muted);font-size:14px;margin:0 0 16px}
  h3{margin:0;font-size:16px}
  .muted2{color:var(--muted);font-size:13px;margin:8px 0 0}
  .row1{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
  .hostname{font-size:19px;letter-spacing:-.02em;word-break:break-all}
  .rowbtn{display:flex;gap:8px;flex-wrap:wrap}
  .lbl{display:block;font-size:13px;font-weight:600;margin:14px 0 6px}
  .err{color:#FF3B30;font-size:13px;margin:10px 0 0}
  .logbox{margin-top:12px;background:rgba(0,0,0,.45);border:1px solid var(--border);border-radius:14px;padding:14px 16px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;line-height:1.7;max-height:220px;overflow:auto;white-space:pre-wrap;word-break:break-word;color:var(--text)}
</style>
