<script>
  import { fly, fade } from 'svelte/transition';
  import Icon from './Icon.svelte';
  export let open = false, onClose;
  let backup = null, loading = true, err = '', progress = 0, progressTimer = null;
  let includePassword = true;
  let includeDomain = true;
  let selectedApps = new Set();
  let loadedOnce = false;
  function fmtSize(b){ if(!b && b!==0) return '-'; if(b<1024) return b+' B'; if(b<1024*1024) return (b/1024).toFixed(1)+' KB'; if(b<1024*1024*1024) return (b/(1024*1024)).toFixed(1)+' MB'; return (b/(1024*1024*1024)).toFixed(2)+' GB'; }
  $: totalBytes = backup ? backup.system.bytes + (includePassword && backup.password.exists ? backup.password.bytes : 0) + (includeDomain && backup.domain && backup.domain.exists ? backup.domain.bytes : 0) + (backup.apps || []).filter((a) => selectedApps.has(a.name)).reduce((s, a) => s + a.bytes, 0) : 0;
  function close(){ stopProgress(); open = false; if (onClose) onClose(); }
  function stopProgress(){ if (progressTimer) { clearInterval(progressTimer); progressTimer = null; } }
  async function load(){
    loading = true; err = ''; backup = null; progress = 0; includePassword = true; includeDomain = true; selectedApps = new Set();
    stopProgress();
    progressTimer = setInterval(() => { if (progress < 90) progress = Math.min(90, progress + (90 - progress) * 0.12 + 1); }, 80);
    const t0 = Date.now();
    try {
      const r = await fetch('/api/backup/info', { credentials: 'same-origin' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'gagal memuat');
      backup = d.backup;
      selectedApps = new Set((backup.apps || []).map((a) => a.name));
      const wait = Math.max(0, 600 - (Date.now() - t0));
      await new Promise((res) => setTimeout(res, wait));
      stopProgress(); progress = 100;
      await new Promise((res) => setTimeout(res, 250));
      loading = false; loadedOnce = true;
    } catch (e) {
      stopProgress(); err = e.message; loading = false;
    }
  }
  $: if (open && !loadedOnce) load();
  $: if (open && loadedOnce && !backup && !loading && !err) load();
  function toggleApp(name){ if (selectedApps.has(name)) selectedApps.delete(name); else selectedApps.add(name); selectedApps = new Set(selectedApps); }
  function download(){
    const apps = (backup?.apps || []).filter((a) => selectedApps.has(a.name)).map((a) => encodeURIComponent(a.name)).join(',');
    window.location.href = '/api/backup/download?password=' + (includePassword ? '1' : '0') + '&domain=' + (includeDomain ? '1' : '0') + '&apps=' + apps;
    close();
  }
</script>

{#if open}
  <div class="sheet-bg" transition:fade={{ duration: 180 }} on:click={(e) => { if (e.target === e.currentTarget) close(); }}>
    <div class="sheet glass-strong" transition:fly={{ y: 80, duration: 320 }}>
      <div class="sheet-head"><h2>Backup</h2><button class="iconbtn" on:click={close} aria-label="Tutup"><Icon name="close" size={18} /></button></div>
      {#if loading}
        <div class="load"><p class="muted2">Memuat daftar backup...</p>
          <div class="bar"><div class="fill" style="width:{Math.round(progress)}%"></div></div>
          <p class="pct">{Math.round(progress)}%</p>
        </div>
      {:else if err}
        <p class="muted2">Gagal memuat: {err}</p>
        <div class="sheet-foot"><button type="button" class="btn" style="flex:1" on:click={close}>Batal</button><button type="button" class="btn primary" style="flex:2" on:click={load}>Coba Lagi</button></div>
      {:else if backup}
        <div class="opts">
          <label class="bk-row"><input type="checkbox" checked disabled /><span>Sistem</span></label>
          <label class="bk-row"><input type="checkbox" bind:checked={includePassword} /><span>Password</span></label>
          {#if backup.domain && backup.domain.exists}
            <label class="bk-row"><input type="checkbox" bind:checked={includeDomain} /><span>Domain</span></label>
          {/if}
          {#each backup.apps as a (a.name)}
            <label class="bk-row"><input type="checkbox" checked={selectedApps.has(a.name)} on:change={() => toggleApp(a.name)} /><span>{a.name}</span></label>
          {/each}
        </div>
        <p class="bk-total">Total: <b>{fmtSize(totalBytes)}</b> · {selectedApps.size} app</p>
        <div class="sheet-foot"><button type="button" class="btn" style="flex:1" on:click={close}>Batal</button><button type="button" class="btn primary" style="flex:2" on:click={download}><Icon name="download" size={16} /> Download Backup</button></div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .sheet-bg{position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:60;display:flex;align-items:flex-end;justify-content:center}
  .sheet{width:100%;max-width:620px;max-height:92vh;overflow:auto;background:var(--glass-bg-strong);border-radius:24px 24px 0 0;padding:8px 20px 28px;position:relative}
  .sheet-head{display:flex;justify-content:space-between;align-items:center}
  .load{padding:18px 0 8px;text-align:center}
  .bar{height:8px;border-radius:999px;background:rgba(0,0,0,.08);overflow:hidden;margin:14px 0 8px}
  .fill{height:100%;border-radius:999px;background:var(--text);transition:width .15s ease}
  .pct{font-size:13px;color:var(--muted);margin:0}
  .opts{margin-top:10px}
  .bk-row{display:flex;align-items:center;gap:10px;margin:13px 0;font-size:14.5px;cursor:pointer}
  .bk-row input{width:17px;height:17px;accent-color:var(--text)}
  .bk-total{font-size:14px;margin:18px 0 0}
  .sheet-foot{display:flex;gap:10px;margin-top:16px}
  .sheet-foot .btn{display:inline-flex;gap:6px;align-items:center;justify-content:center}
  .muted2{color:var(--muted);font-size:13px;margin:8px 0 0}
</style>
