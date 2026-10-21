<script>
  import Icon from './Icon.svelte';
  export let apps = [], onAct, onOpenSheet, onOpenLogs, onOpenFiles, onDelete, onSetup, onOpenTerm, onTogglePublic;
  let q = '', filter = 'all';
  $: list = apps.filter(a => {
    if (filter === 'running' && a.status !== 'running') return false;
    if (filter === 'stopped' && a.status === 'running') return false;
    if (q && (a.name + ' ' + (a.description || '')).toLowerCase().indexOf(q.toLowerCase()) < 0) return false;
    return true;
  });
</script>

<div class="anim-slide-up">
  <h2 class="title">Aplikasi</h2>
  <p class="sub">Semua app Node.js / Python / Static dalam 1 server, 1 port publik.</p>
  <div class="searchrow"><Icon name="search" size={18} /><input bind:value={q} placeholder="Cari app..." /></div>
  <div class="seg" style="margin:12px 0">
    <button class:active={filter === 'all'} on:click={() => filter = 'all'}>Semua</button>
    <button class:active={filter === 'running'} on:click={() => filter = 'running'}>Berjalan</button>
    <button class:active={filter === 'stopped'} on:click={() => filter = 'stopped'}>Berhenti</button>
  </div>
  <button class="btn primary" style="margin-bottom:14px;display:inline-flex;gap:6px;align-items:center" on:click={onOpenSheet}><Icon name="plus" size={16} /> Tambah App</button>
  <div class="list">
    {#if !list.length}<div class="card"><p>Tidak ada app yang cocok.</p></div>{/if}
    {#each list as a (a.name)}
      <div class="card hoverable appcard">
        <div class="row1 clickable" role="button" tabindex="0" title="Buka File Manager" on:click={() => onOpenFiles && onOpenFiles('apps/' + a.name)} on:keydown={(e) => { if (e.key === 'Enter') onOpenFiles && onOpenFiles('apps/' + a.name); }}><b>{a.name}</b><span class="pill"><span class="dot {a.status}"></span>{a.status}</span></div>
        <p class="muted2">{a.description || ''} · port {a.port} · <code>{a.command}</code></p>
        <div class="rowbtn">
          <button class="btn small" on:click|stopPropagation={() => onAct(a.name, 'start')}><Icon name="play" size={14} /> Start</button>
          <button class="btn small" on:click|stopPropagation={() => onAct(a.name, 'stop')}><Icon name="stop" size={14} /> Stop</button>
          <button class="btn small" on:click|stopPropagation={() => onAct(a.name, 'restart')}><Icon name="refresh" size={14} /> Restart</button>
          {#if a.suspended}<button class="btn small primary" on:click|stopPropagation={() => onAct(a.name, 'resume')}><Icon name="play" size={14} /> Aktifkan</button>{:else}<button class="btn small" on:click|stopPropagation={() => onAct(a.name, 'suspend')}><Icon name="pause" size={14} /> Suspend</button>{/if}
          <button class="btn small primary" on:click|stopPropagation={() => window.open('/app/' + a.name + '/', '_blank')}><Icon name="open" size={14} /> Buka</button>
          <button class="btn small" class:primary={a.public} title={a.public ? 'Publik: bisa dibuka siapa aja tanpa login' : 'Private: hanya yang login'} on:click|stopPropagation={() => onTogglePublic && onTogglePublic(a.name, !a.public)}><Icon name={a.public ? 'eye' : 'lock'} size={14} /> {a.public ? 'Publik' : 'Private'}</button>
          <button class="btn small" on:click|stopPropagation={() => onOpenLogs(a.name)}><Icon name="logs" size={14} /> Log</button>
          <button class="btn small" on:click|stopPropagation={() => onOpenTerm && onOpenTerm(a.name)}><Icon name="terminal" size={14} /> Terminal</button>
          <button class="btn small" on:click|stopPropagation={() => onOpenFiles && onOpenFiles('apps/' + a.name)}><Icon name="folder" size={14} /> File</button>
          <button class="btn small" on:click|stopPropagation={() => onSetup && onSetup(a.name)}><Icon name="settings" size={14} /> Setup</button>
          <button class="btn small danger" on:click|stopPropagation={() => onDelete && onDelete(a.name)}><Icon name="trash" size={14} /> Hapus</button>
        </div>
      </div>
    {/each}
  </div>
</div>

<style>
  .title{font-size:24px;letter-spacing:-.02em;margin:4px 0 4px}
  .sub{color:var(--muted);font-size:14px;margin:0 0 16px}
  .searchrow{display:flex;gap:8px;align-items:center;background:var(--glass-bg);-webkit-backdrop-filter:blur(20px) saturate(180%);backdrop-filter:blur(20px) saturate(180%);border:1px solid var(--glass-border);border-radius:12px;padding:0 12px}
  .searchrow input{border:none;background:transparent;padding:11px 0}
  .searchrow input:focus{border:none}
  .list{display:grid;gap:14px}
  .appcard{display:flex;flex-direction:column;gap:10px}
  .row1{display:flex;justify-content:space-between;gap:8px;align-items:center}
  .row1.clickable{cursor:pointer;border-radius:10px;padding:2px 4px;margin:-2px -4px}
  .row1.clickable:hover{background:var(--card2)}
  .row1.clickable b{text-decoration:underline;text-underline-offset:3px}
  .muted2{color:var(--muted);font-size:13px;margin:0}
  .rowbtn{display:flex;gap:8px;flex-wrap:wrap}
  .rowbtn .btn{display:inline-flex;gap:6px;align-items:center}
  code{background:var(--card2);padding:2px 6px;border-radius:6px;font-size:12px}
</style>
