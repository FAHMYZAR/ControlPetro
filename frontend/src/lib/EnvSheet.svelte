<script>
  import { onMount } from 'svelte';
  import Icon from './Icon.svelte';
  export let appName = '', onClose = null, onSaved = null, onToast = null;
  let envText = '', cfg = null, err = '', busy = false, loading = true;

  function envToText(env) {
    return Object.entries(env || {}).map(([k, v]) => k + '=' + v).join('\n');
  }
  function parseEnv(txt) {
    const env = {};
    (txt || '').split('\n').forEach((line) => {
      line = line.trim();
      if (!line || line.startsWith('#')) return;
      const ix = line.indexOf('=');
      if (ix > 0) env[line.slice(0, ix).trim()] = line.slice(ix + 1).trim();
    });
    return env;
  }
  async function load() {
    loading = true; err = '';
    try {
      const r = await fetch('/api/apps/' + encodeURIComponent(appName), { credentials: 'same-origin' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Gagal memuat app');
      cfg = j.app || j;
      envText = envToText(cfg.env || {});
    } catch (e) { err = e.message; }
    loading = false;
  }
  async function save() {
    if (!cfg) return;
    busy = true; err = '';
    try {
      const body = {
        port: cfg.port,
        command: cfg.command,
        buildCommand: cfg.buildCommand || '',
        installCommand: cfg.installCommand || '',
        autostart: cfg.autostart !== false,
        env: parseEnv(envText),
      };
      const r = await fetch('/api/apps/' + encodeURIComponent(appName) + '/deploy', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'Gagal menyimpan env');
      onToast && onToast('Env disimpan, ' + appName + ' di-restart');
      onSaved && onSaved();
      onClose && onClose();
    } catch (e) { err = e.message; }
    busy = false;
  }
  onMount(load);
</script>

<div class="sheet-backdrop" on:click={onClose} role="presentation"></div>
<div class="sheet">
  <div class="sheet-head">
    <h3>Environment: {appName}</h3>
    <button class="iconbtn" on:click={onClose} aria-label="Tutup"><Icon name="close" size={18} /></button>
  </div>
  {#if loading}
    <p class="muted">Memuat...</p>
  {:else}
    <label>Environment <span>1 baris per variabel: KEY=value</span></label>
    <textarea bind:value={envText} rows="8" placeholder={'META_API_KEY=...'}></textarea>
    <p class="muted2">Disimpan ke app, app otomatis restart. Baris kosong dan # komentar diabaikan.</p>
    {#if err}<p class="err">{err}</p>{/if}
    <div class="row-end">
      <button class="btn" on:click={onClose}>Batal</button>
      <button class="btn primary" on:click={save} disabled={busy}>{busy ? 'Menyimpan...' : 'Simpan & restart'}</button>
    </div>
  {/if}
</div>

<style>
  .sheet-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:60}
  .sheet{position:fixed;left:12px;right:12px;bottom:12px;z-index:61;background:var(--card);border:1px solid var(--border);border-radius:20px;padding:18px;box-shadow:0 16px 48px rgba(0,0,0,.25)}
  .sheet-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
  .sheet-head h3{margin:0;font-size:16px}
  label{display:block;font-size:13px;font-weight:600;margin-bottom:6px}
  label span{font-weight:400;color:var(--muted)}
  textarea{font-family:ui-monospace,Menlo,monospace;font-size:13px}
  .muted{color:var(--muted)}
  .muted2{color:var(--muted);font-size:12px;margin:8px 0}
  .err{color:#FF3B30;font-size:13px}
  .row-end{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}
</style>
