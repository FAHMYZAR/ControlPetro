<script>
  import { onMount } from 'svelte';
  import Icon from './Icon.svelte';
  export let apps = [], focusApp = '';
  let sel = '', text = '', busy = false;
  async function api(p, opt) {
    const r = await fetch(p, Object.assign({ credentials: 'same-origin' }, opt || {}));
    if (r.status === 401) { window.location.href = '/login'; throw new Error('auth'); }
    return r;
  }
  async function load() {
    busy = true;
    const url = '/api/logs?limit=300' + (sel ? '&app=' + encodeURIComponent(sel) : '');
    const r = await api(url); const j = await r.json();
    text = (j.logs || []).map(x => new Date(x.t).toLocaleTimeString() + ' [' + x.app + '] ' + x.line).join('\n') || '(belum ada log)';
    busy = false;
  }
  function download() {
    const blob = new Blob([text], { type: 'text/plain' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'bridge-logs.txt'; a.click();
  }
  $: if (focusApp) sel = focusApp;
  onMount(() => { load(); });
</script>

<div class="anim-slide-up">
  <h2 class="title">Log</h2>
  <p class="sub">Log semua app. Pilih 1 app untuk fokus, atau Semua untuk gabungan.</p>
  <div class="row">
    <select bind:value={sel} on:change={load} style="flex:1;min-width:160px"><option value="">Semua app</option>{#each apps as a}<option value={a.name}>{a.name}</option>{/each}</select>
    <button class="btn" on:click={load} disabled={busy}><Icon name="refresh" size={14} spin={busy} /> Muat ulang</button>
    <button class="btn" on:click={download}><Icon name="download" size={14} /> Unduh .txt</button>
  </div>
  <pre class="log" style="margin-top:12px">{text || 'Memuat log...'}</pre>
</div>

<style>
  .title{font-size:24px;letter-spacing:-.02em;margin:4px 0 4px}
  .sub{color:var(--muted);font-size:14px;margin:0 0 16px}
  .row{display:flex;gap:8px;flex-wrap:wrap}
  .row .btn{display:inline-flex;gap:6px;align-items:center}
</style>
