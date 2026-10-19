<script>
  import { onMount } from 'svelte';
  import Icon from './Icon.svelte';

  let domain = null, loading = true;
  let err = '';
  let busy = ''; // 'connect' | 'setup' | 'restart' | 'disconnect' | 'status' | 'extraAdd' | 'extraDel'
  let apiToken = '', zones = [], zoneId = '', subdomain = '';
  let showSetup = false; // form pilih zone + subdomain sesudah connect sukses
  let showConnect = false; // form hubungkan (awal, atau ganti domain)
  // Domain tambahan
  let extraZones = [], extraZoneId = '', extraSubdomain = '', extraPort = '';
  let showTambah = false, errExtra = '';

  async function loadStatus(retry = 0) {
    busy = 'status';
    try {
      const r = await fetch('/api/domain/status', { credentials: 'same-origin' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'gagal memuat status domain');
      domain = d.domain || null;
      err = '';
    } catch (e) {
      // Retry otomatis 2x (tiap 1.5 dtk) buat error transient,
      // misal server lagi sibuk restart tunnel habis tambah/hapus domain.
      if (retry < 2) {
        await new Promise((ok) => setTimeout(ok, 1500));
        return loadStatus(retry + 1);
      }
      err = e.message;
    }
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

  // --- Domain tambahan ---
  $: previewHostname = (() => {
    const sub = extraSubdomain.trim().toLowerCase();
    const z = extraZones.find((x) => x.id === extraZoneId);
    if (!sub || !z || !validSubdomain(sub)) return '';
    return sub + '.' + z.name;
  })();

  async function mulaiTambah() {
    errExtra = ''; showTambah = true;
    if (!extraZones.length) {
      try {
        const r = await fetch('/api/domain/zones', { credentials: 'same-origin' });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || 'gagal ambil zones');
        extraZones = d.zones || [];
        extraZoneId = extraZones.length ? extraZones[0].id : '';
      } catch (e) { errExtra = e.message; }
    }
  }

  async function tambahExtra() {
    const sub = extraSubdomain.trim().toLowerCase();
    const port = parseInt(extraPort, 10);
    if (!extraZoneId) { errExtra = 'Pilih zone dulu.'; return; }
    if (!validSubdomain(sub)) { errExtra = 'Subdomain tidak valid. Pakai huruf kecil, angka, dan dash, tanpa spasi.'; return; }
    if (!Number.isInteger(port) || port < 1 || port > 65535) { errExtra = 'Port harus angka 1-65535.'; return; }
    errExtra = ''; busy = 'extraAdd';
    try {
      const r = await fetch('/api/domain/extra/add', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ zoneId: extraZoneId, subdomain: sub, port }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'gagal tambah domain');
      showTambah = false; extraSubdomain = ''; extraPort = '';
      await loadStatus();
    } catch (e) { errExtra = e.message; }
    busy = '';
  }

  async function hapusExtra(hostname) {
    if (!window.confirm('Hapus domain ' + hostname + '? DNS dan aturan tunnel di Cloudflare ikut dihapus.')) return;
    busy = 'extraDel';
    try {
      const r = await fetch('/api/domain/extra/delete', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hostname }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'gagal hapus domain');
      await loadStatus();
    } catch (e) { err = e.message; }
    busy = '';
  }

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

    <div class="card" style="margin-top:14px">
      <div class="row1"><h3>Domain Tambahan</h3></div>
      <p class="muted2">Domain ekstra lewat tunnel yang sama, masing-masing ke port internal sendiri. Contoh: satu domain buat tiap app.</p>
      {#if domain.extraDomains && domain.extraDomains.length}
        <div class="extralist">
          {#each domain.extraDomains as ex}
            <div class="extrarow">
              <div class="extrahost"><b>{ex.hostname}</b><span class="muted2"> → port {ex.port}</span></div>
              <button class="btn small danger" disabled={busy !== ''} on:click={() => hapusExtra(ex.hostname)}><Icon name="trash" size={14} /> {busy === 'extraDel' ? 'Menghapus...' : 'Hapus'}</button>
            </div>
          {/each}
        </div>
      {:else}
        <p class="muted2">Belum ada domain tambahan.</p>
      {/if}
      {#if !showTambah}
        <button class="btn small" style="margin-top:12px" disabled={busy !== ''} on:click={mulaiTambah}><Icon name="plus" size={14} /> Tambah Domain</button>
      {:else}
        <label class="lbl">Zone</label>
        <select bind:value={extraZoneId}>
          {#each extraZones as z}<option value={z.id}>{z.name}</option>{/each}
        </select>
        <label class="lbl">Subdomain</label>
        <input placeholder="contoh: bot" bind:value={extraSubdomain} />
        {#if previewHostname}
          <p class="preview">Jadinya: <b>{previewHostname}</b></p>
        {/if}
        <label class="lbl">Port Internal</label>
        <input type="number" placeholder="contoh: 3101" bind:value={extraPort} min="1" max="65535" />
        {#if errExtra}<p class="err">{errExtra}</p>{/if}
        <div class="rowbtn" style="margin-top:10px">
          <button class="btn primary small" disabled={busy !== ''} on:click={tambahExtra}>{busy === 'extraAdd' ? 'Memproses...' : 'Tambah'}</button>
          <button class="btn small" disabled={busy !== ''} on:click={() => { showTambah = false; errExtra = ''; }}>Batal</button>
        </div>
      {/if}
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
  .extralist{margin-top:12px;display:flex;flex-direction:column;gap:8px}
  .extrarow{display:flex;align-items:center;justify-content:space-between;gap:10px;background:rgba(255,255,255,.04);border:1px solid var(--border);border-radius:12px;padding:10px 12px;flex-wrap:wrap}
  .extrahost{font-size:14px;word-break:break-all}
  .extrahost .muted2{margin-left:6px}
  .preview{margin:10px 0 0;font-size:14px;color:var(--muted)}
  .preview b{color:var(--text)}
</style>
