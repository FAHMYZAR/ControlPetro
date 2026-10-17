<script>
  import { fade, fly } from 'svelte/transition';
  import Icon from './Icon.svelte';
  export let initialPath = 'apps';
  export let onToast = () => {};
  let curPath = initialPath || 'apps';
  let entries = [], loading = false, err = '', q = '';
  let editor = null; // {path, name, content, mode, modeStr, size, dirty}
  let editorBusy = false;
  let showNewFile = false, showNewFolder = false, showUpload = false, showDelete = null, showRename = null, showPerm = null;
  let newName = '', newFileContent = '';
  let uploadList = [], uploadBusy = false, uploadDrag = false, uploadInputEl = null;
  let permBits = { oR: false, oW: false, oX: false, gR: false, gW: false, gX: false, tR: false, tW: false, tX: false };
  let permSaving = false;
  let renameName = '';

  function fmtSize(n) { if (n == null || n === 0) return '-'; if (n > 1e6) return (n / 1e6).toFixed(1) + ' MB'; if (n > 1e3) return (n / 1e3).toFixed(1) + ' KB'; return n + ' B'; }
  function fmtDate(ms) { if (!ms) return '-'; try { return new Date(ms).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch { return '-'; } }
  function iconFor(e) {
    if (e.type === 'dir') return 'folder';
    const ext = (e.ext || '').toLowerCase();
    if (['js', 'cjs', 'mjs', 'ts', 'py', 'html', 'css', 'json', 'sh', 'yml', 'yaml', 'xml'].includes(ext)) return 'fileCode';
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'svg', 'bmp'].includes(ext)) return 'fileImage';
    if (['txt', 'md', 'log', 'env'].includes(ext)) return 'fileText';
    return 'file';
  }
  function crumbs() {
    if (curPath === 'apps') return [{ label: 'Root', path: 'apps' }];
    const parts = curPath.split('/');
    const out = [{ label: 'Root', path: 'apps' }];
    let acc = '';
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === 'apps' && i === 0) continue;
      acc = acc ? acc + '/' + parts[i] : parts[i];
      // acc for parts after 'apps' needs prefix
      const p = 'apps/' + parts.slice(1, i + 1).join('/');
      out.push({ label: parts[i], path: p });
    }
    return out;
  }
  async function load(p) {
    const target = p || curPath;
    loading = true; err = ''; q = '';
    try {
      const r = await fetch('/api/files?path=' + encodeURIComponent(target), { credentials: 'same-origin' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'Gagal memuat folder');
      curPath = j.path;
      entries = j.entries || [];
      if (curPath === 'apps') entries = [{ name: 'apps.json', path: 'apps.json', type: 'file', size: 0, mtime: 0, mode: '', modeStr: '', ext: 'json', virtual: true }, ...entries];
    } catch (e) { err = e.message; entries = []; }
    loading = false;
  }
  function filtered() {
    if (!q) return entries;
    const needle = q.toLowerCase();
    return entries.filter((e) => e.name.toLowerCase().includes(needle));
  }
  async function openEntry(e) {
    if (e.type === 'dir') { load(e.path); return; }
    await openFile(e);
  }
  async function openFile(e) {
    err = '';
    try {
      const r = await fetch('/api/files/content?path=' + encodeURIComponent(e.path), { credentials: 'same-origin' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'Gagal membuka file');
      editor = { path: e.path, name: e.name, content: j.content, mode: j.mode, modeStr: j.modeStr, size: j.size, dirty: false };
      initPerm(j.mode);
    } catch (ex) {
      if (String(ex.message).includes('binary')) {
        // Binary: offer download
        window.open('/api/files/content?path=' + encodeURIComponent(e.path) + '&download=1', '_blank');
        onToast('File binary, mengunduh...');
      } else { err = ex.message; }
    }
  }
  function initPerm(modeStr) {
    const m = String(modeStr || '644');
    const d = (c) => parseInt(c, 10);
    const o = d(m[0] || '6'), g = d(m[1] || '4'), t = d(m[2] || '4');
    permBits = { oR: !!(o & 4), oW: !!(o & 2), oX: !!(o & 1), gR: !!(g & 4), gW: !!(g & 2), gX: !!(g & 1), tR: !!(t & 4), tW: !!(t & 2), tX: !!(t & 1) };
  }
  function permOctal() {
    const v = (r, w, x) => (r ? 4 : 0) + (w ? 2 : 0) + (x ? 1 : 0);
    return '' + v(permBits.oR, permBits.oW, permBits.oX) + v(permBits.gR, permBits.gW, permBits.gX) + v(permBits.tR, permBits.tW, permBits.tX);
  }
  async function saveEditor() {
    if (!editor) return;
    editorBusy = true;
    try {
      const r = await fetch('/api/files/write', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ path: editor.path, content: editor.content }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'Gagal menyimpan');
      editor.dirty = false;
      onToast('Tersimpan: ' + editor.name);
      load(curPath);
    } catch (e) { err = e.message; }
    editorBusy = false;
  }
  async function savePerm() {
    if (!editor) return;
    permSaving = true;
    try {
      const mode = permOctal();
      const r = await fetch('/api/files/chmod', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ path: editor.path, mode }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'Gagal mengubah permission');
      editor.mode = mode;
      editor.modeStr = (editor.modeStr ? editor.modeStr[0] : '-') + ((m) => { const map = ['---', '--x', '-w-', '-wx', 'r--', 'r-x', 'rw-', 'rwx']; return map[parseInt(m[0], 10)] + map[parseInt(m[1], 10)] + map[parseInt(m[2], 10)]; })(mode);
      showPerm = false;
      onToast('Permission jadi ' + mode);
      load(curPath);
    } catch (e) { err = e.message; }
    permSaving = false;
  }
  async function doDelete(target) {
    try {
      const r = await fetch('/api/files/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ path: target.path }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'Gagal menghapus');
      // Kalau yang dihapus adalah folder root app (apps/<nama>), hapus juga registry app-nya
      // supaya app tidak tetap muncul di dashboard. Tanpa ini, hapus folder saja tidak cukup.
      const m = /^apps\/([^\/]+)$/.exec(target.path);
      if (m && target.type === 'dir') {
        try {
          const rd = await fetch('/api/apps/' + encodeURIComponent(m[1]), { method: 'DELETE', credentials: 'same-origin' });
          if (rd.ok) onToast('App ' + m[1] + ' dihapus dari dashboard juga');
        } catch {}
      }
      onToast('Dihapus: ' + target.name);
      if (editor && editor.path === target.path) editor = null;
      showDelete = null;
      load(curPath);
    } catch (e) { err = e.message; }
  }
  async function doRename() {
    if (!showRename) return;
    const name = renameName.trim();
    if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) { err = 'Nama baru tidak valid'; return; }
    const base = showRename.path.split('/').slice(0, -1).join('/');
    const to = base ? base + '/' + name : name;
    try {
      const r = await fetch('/api/files/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ from: showRename.path, to }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'Gagal rename');
      onToast('Diubah jadi ' + name);
      if (editor && editor.path === showRename.path) { editor.path = to; editor.name = name; }
      showRename = null;
      load(curPath);
    } catch (e) { err = e.message; }
  }
  async function doNewFile() {
    const name = newName.trim();
    if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) { err = 'Nama file tidak valid'; return; }
    const p = curPath === 'apps' ? 'apps/' + name : curPath + '/' + name;
    try {
      const r = await fetch('/api/files/write', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ path: p, content: newFileContent }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'Gagal membuat file');
      showNewFile = false; newName = ''; newFileContent = '';
      onToast('File dibuat: ' + name);
      load(curPath);
    } catch (e) { err = e.message; }
  }
  async function doNewFolder() {
    const name = newName.trim();
    if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) { err = 'Nama folder tidak valid'; return; }
    const p = curPath === 'apps' ? 'apps/' + name : curPath + '/' + name;
    try {
      const r = await fetch('/api/files/mkdir', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ path: p }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'Gagal membuat folder');
      showNewFolder = false; newName = '';
      onToast('Folder dibuat: ' + name);
      load(curPath);
    } catch (e) { err = e.message; }
  }
  function onUploadPicked(e) { handleUploadFiles(e.target.files); if (uploadInputEl) uploadInputEl.value = ''; }
  function handleUploadFiles(list) {
    const files = Array.from(list || []);
    let total = uploadList.reduce((s, f) => s + (f.size || 0), 0);
    for (const f of files) {
      if (uploadList.some(x => x.name === f.name && x.size === f.size)) continue;
      total += f.size;
      // Simpan File asli, dikirim sebagai multipart binary (bukan base64).
      uploadList = [...uploadList, f];
    }
    if (total > 100 * 1024 * 1024) err = 'Total file melebihi 100 MB';
    else err = '';
  }
  function removeUpload(i) { uploadList.splice(i, 1); uploadList = [...uploadList]; }
  async function doUpload() {
    if (!uploadList.length) { err = 'Pilih minimal 1 file'; return; }
    const total = uploadList.reduce((s, f) => s + (f.size || 0), 0);
    if (total > 100 * 1024 * 1024) { err = 'Total file melebihi 100 MB'; return; }
    uploadBusy = true;
    try {
      const fd = new FormData();
      fd.append('path', curPath);
      for (const f of uploadList) fd.append('files', f, f.name);
      const r = await fetch('/api/files/upload', { method: 'POST', credentials: 'same-origin', body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'Gagal upload');
      showUpload = false; uploadList = [];
      onToast('Upload berhasil: ' + (j.uploaded || []).join(', '));
      load(curPath);
    } catch (e) { err = e.message; }
    uploadBusy = false;
  }
  function goUp() {
    if (curPath === 'apps') return;
    const parts = curPath.split('/');
    if (parts.length <= 1) { load('apps'); return; }
    load(parts.slice(0, -1).join('/') || 'apps');
  }
  load(curPath);
</script>

<div class="anim-slide-up">
  <h2 class="title">File Manager</h2>
  <p class="sub">Kelola file semua app. Root hanya apps/ + apps.json.</p>
  <div class="crumbs">
    {#each crumbs() as c, i}
      <button class="crumb" on:click={() => load(c.path)}>{c.label}</button>
      {#if i < crumbs().length - 1}<span class="sep">/</span>{/if}
    {/each}
  </div>
  <div class="toolbar">
    <button class="btn small" on:click={goUp} disabled={curPath === 'apps'}><Icon name="chevronLeft" size={14} /> Kembali</button>
    <button class="btn small" on:click={() => load(curPath)}><Icon name="refresh" size={14} /> Refresh</button>
    <button class="btn small" on:click={() => { showNewFolder = true; newName = ''; }}><Icon name="folder" size={14} /> Folder Baru</button>
    <button class="btn small" on:click={() => { showNewFile = true; newName = ''; newFileContent = ''; }}><Icon name="plus" size={14} /> File Baru</button>
    <button class="btn small" on:click={() => { showUpload = true; uploadList = []; }}><Icon name="upload" size={14} /> Upload</button>
  </div>
  <div class="searchrow"><Icon name="search" size={18} /><input bind:value={q} placeholder="Cari di folder ini..." /></div>
  {#if err}<div class="errbox">{err}</div>{/if}
  {#if loading}
    <div class="card"><p>Memuat...</p></div>
  {:else if !filtered().length}
    <div class="card"><p>Folder ini kosong.</p></div>
  {:else}
    <div class="filelist">
      {#each filtered() as e (e.path)}
        <div class="filerow" on:click={() => openEntry(e)} role="button" tabindex="0" on:keydown={(ev) => { if (ev.key === 'Enter') openEntry(e); }}>
          <span class="fico"><Icon name={iconFor(e)} size={22} /></span>
          <span class="fname"><b>{e.name}</b><span class="fmeta">{e.type === 'dir' ? 'Folder' : fmtSize(e.size)} · {e.modeStr || '-'}{e.type === 'file' ? ' · ' + fmtDate(e.mtime) : ''}</span></span>
          {#if e.path !== 'apps.json'}
            <button class="rowact" title="Rename" on:click|stopPropagation={() => { renameName = e.name; showRename = { path: e.path, name: e.name }; }}><Icon name="edit" size={16} /></button>
            <button class="rowact danger" title="Hapus" on:click|stopPropagation={() => { showDelete = { path: e.path, name: e.name, type: e.type }; }}><Icon name="trash" size={16} /></button>
          {/if}
          {#if e.type === 'dir'}<Icon name="chevronRight" size={16} />{/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

{#if editor}
  <div class="sheet-bg" transition:fade={{ duration: 180 }}>
    <div class="sheet glass-strong" transition:fly={{ y: 60, duration: 280 }}>
      <div class="sheet-head">
        <div><b>{editor.name}</b><p class="muted2">{editor.path} · {editor.modeStr} ({editor.mode}) · {fmtSize(editor.size)}</p></div>
        <button class="iconbtn" on:click={() => { editor = null; showPerm = false; }} aria-label="Tutup"><Icon name="close" size={18} /></button>
      </div>
      <textarea class="editor" bind:value={editor.content} on:input={() => { editor.dirty = true; }} spellcheck="false"></textarea>
      <div class="sheet-actions">
        <button class="btn primary" on:click={saveEditor} disabled={editorBusy || !editor.dirty}>{#if editorBusy}Menyimpan...{:else}Simpan{/if}</button>
        <button class="btn" on:click={() => window.open('/api/files/content?path=' + encodeURIComponent(editor.path) + '&download=1', '_blank')}><Icon name="download" size={14} /> Unduh</button>
        {#if editor.path !== 'apps.json'}
          <button class="btn" on:click={() => { renameName = editor.name; showRename = { path: editor.path, name: editor.name }; }}><Icon name="edit" size={14} /> Rename</button>
          <button class="btn" on:click={() => { showPerm = showPerm ? null : true; }}><Icon name="lock" size={14} /> Permission</button>
          <button class="btn danger" on:click={() => { showDelete = { path: editor.path, name: editor.name, type: 'file' }; }}><Icon name="trash" size={14} /> Hapus</button>
        {/if}
      </div>
      {#if showPerm}
        <div class="perm" transition:fade={{ duration: 150 }}>
          <h4>Permission — <code>{permOctal()}</code></h4>
          <div class="perm-grid">
            <span></span><span>Read</span><span>Write</span><span>Execute</span>
            <span>Owner</span><label><input type="checkbox" bind:checked={permBits.oR} /></label><label><input type="checkbox" bind:checked={permBits.oW} /></label><label><input type="checkbox" bind:checked={permBits.oX} /></label>
            <span>Group</span><label><input type="checkbox" bind:checked={permBits.gR} /></label><label><input type="checkbox" bind:checked={permBits.gW} /></label><label><input type="checkbox" bind:checked={permBits.gX} /></label>
            <span>Other</span><label><input type="checkbox" bind:checked={permBits.tR} /></label><label><input type="checkbox" bind:checked={permBits.tW} /></label><label><input type="checkbox" bind:checked={permBits.tX} /></label>
          </div>
          <button class="btn primary" on:click={savePerm} disabled={permSaving}>{permSaving ? 'Menyimpan...' : 'Simpan Permission'}</button>
        </div>
      {/if}
    </div>
  </div>
{/if}

{#if showNewFile}
  <div class="sheet-bg" transition:fade={{ duration: 180 }} on:click={(e) => { if (e.target === e.currentTarget) showNewFile = false; }}>
    <div class="sheet glass-strong small" transition:fly={{ y: 60, duration: 280 }}>
      <h3>File Baru</h3>
      <label>Nama file</label>
      <input bind:value={newName} placeholder="misal: README.md" />
      <label>Isi awal (opsional)</label>
      <textarea bind:value={newFileContent} rows="4" placeholder="// tulis di sini"></textarea>
      <div class="sheet-actions"><button class="btn" on:click={() => showNewFile = false}>Batal</button><button class="btn primary" on:click={doNewFile}>Buat</button></div>
    </div>
  </div>
{/if}
{#if showNewFolder}
  <div class="sheet-bg" transition:fade={{ duration: 180 }} on:click={(e) => { if (e.target === e.currentTarget) showNewFolder = false; }}>
    <div class="sheet glass-strong small" transition:fly={{ y: 60, duration: 280 }}>
      <h3>Folder Baru</h3>
      <label>Nama folder</label>
      <input bind:value={newName} placeholder="misal: utils" />
      <div class="sheet-actions"><button class="btn" on:click={() => showNewFolder = false}>Batal</button><button class="btn primary" on:click={doNewFolder}>Buat</button></div>
    </div>
  </div>
{/if}
{#if showUpload}
  <div class="sheet-bg" transition:fade={{ duration: 180 }} on:click={(e) => { if (e.target === e.currentTarget) showUpload = false; }}>
    <div class="sheet glass-strong small" transition:fly={{ y: 60, duration: 280 }}>
      <h3>Upload File</h3>
      <p class="muted2">Upload ke folder: <code>{curPath}</code> · maks total 100 MB</p>
      <div class="dropzone" class:drag={uploadDrag} role="button" tabindex="0" title="Pilih file"
        on:click={() => uploadInputEl && uploadInputEl.click()}
        on:keydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); uploadInputEl && uploadInputEl.click(); } }}
        on:dragover|preventDefault={() => uploadDrag = true}
        on:dragleave={() => uploadDrag = false}
        on:drop|preventDefault={(e) => { uploadDrag = false; handleUploadFiles(e.dataTransfer.files); }}>
        <input bind:this={uploadInputEl} type="file" multiple on:change={onUploadPicked} class="file-input-hidden" />
        <span class="dropicon"><Icon name="upload" size={26} /></span>
        <b>{uploadList.length ? uploadList.length + ' file dipilih' : 'Pilih file'}</b>
        <span class="dropsub">Klik atau tarik file ke sini · maks total 100 MB</span>
        <span class="btn small primary droppick"><Icon name="plus" size={14} /> Pilih File</span>
      </div>
      {#if uploadList.length}<div class="filechips">{#each uploadList as f, i}<div class="filechip"><Icon name={iconFor({ type: 'file', ext: (f.name.split('.').pop() || '').toLowerCase() })} size={16} /><span class="chipname">{f.name}</span><small>{fmtSize(f.size)}</small><button type="button" class="chipx" on:click|stopPropagation={() => removeUpload(i)} aria-label="Hapus {f.name}">×</button></div>{/each}</div>{/if}
      <div class="sheet-actions"><button class="btn" on:click={() => showUpload = false}>Batal</button><button class="btn primary" on:click={doUpload} disabled={uploadBusy || !uploadList.length}>{uploadBusy ? 'Mengupload...' : 'Upload'}</button></div>
    </div>
  </div>
{/if}
{#if showDelete}
  <div class="sheet-bg" transition:fade={{ duration: 180 }}>
    <div class="sheet glass-strong small" transition:fly={{ y: 60, duration: 280 }}>
      <h3>Hapus {showDelete.type === 'dir' ? 'folder' : 'file'}?</h3>
      <p class="muted2">Hapus <b>{showDelete.name}</b>{showDelete.type === 'dir' ? ' beserta seluruh isinya (rekursif)' : ''}. Tindakan ini tidak bisa dibatalkan.</p>
      {#if /^apps\/[^\/]+$/.test(showDelete.path) && showDelete.type === 'dir'}<p class="muted2">Ini folder root app — app-nya juga akan dihapus dari dashboard.</p>{/if}
      <div class="sheet-actions"><button class="btn" on:click={() => showDelete = null}>Batal</button><button class="btn danger" on:click={() => doDelete(showDelete)}>Hapus</button></div>
    </div>
  </div>
{/if}
{#if showRename}
  <div class="sheet-bg" transition:fade={{ duration: 180 }}>
    <div class="sheet glass-strong small" transition:fly={{ y: 60, duration: 280 }}>
      <h3>Rename</h3>
      <p class="muted2">{showRename.path}</p>
      <label>Nama baru</label>
      <input bind:value={renameName} />
      <div class="sheet-actions"><button class="btn" on:click={() => showRename = null}>Batal</button><button class="btn primary" on:click={doRename}>Simpan</button></div>
    </div>
  </div>
{/if}

<style>
  .title{font-size:24px;letter-spacing:-.02em;margin:4px 0 4px}
  .sub{color:var(--muted);font-size:14px;margin:0 0 16px}
  .crumbs{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
  .crumb{border:none;background:var(--glass-bg);-webkit-backdrop-filter:blur(20px) saturate(180%);backdrop-filter:blur(20px) saturate(180%);border:1px solid var(--glass-border);border-radius:999px;padding:7px 12px;font-size:13px;font-weight:600;color:var(--text);cursor:pointer}
  .crumb:active{transform:scale(.96)}
  .sep{color:var(--muted)}
  .toolbar{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
  .toolbar .btn{display:inline-flex;gap:6px;align-items:center}
  .searchrow{display:flex;gap:8px;align-items:center;background:var(--glass-bg);-webkit-backdrop-filter:blur(20px) saturate(180%);backdrop-filter:blur(20px) saturate(180%);border:1px solid var(--glass-border);border-radius:12px;padding:0 12px;margin-bottom:12px}
  .searchrow input{border:none;background:transparent;padding:11px 0}
  .searchrow input:focus{border:none}
  .errbox{background:#FFF0F0;color:#C00;border-radius:10px;padding:10px 12px;font-size:13px;margin-bottom:12px}
  .filelist{display:grid;gap:8px}
  .filerow{display:flex;gap:12px;align-items:center;background:var(--glass-bg);-webkit-backdrop-filter:blur(20px) saturate(180%);backdrop-filter:blur(20px) saturate(180%);border:1px solid var(--glass-border);border-radius:16px;padding:12px 14px;cursor:pointer;transition:transform .15s ease,box-shadow .15s ease}
  .filerow:hover{transform:translateY(-1px);box-shadow:0 4px 14px rgba(0,0,0,.07)}
  .filerow:active{transform:scale(.98)}
  .fico{flex:none}
  .fname{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
  .fname b{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .fmeta{color:var(--muted);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .rowact{flex:none;width:32px;height:32px;border-radius:10px;border:1px solid var(--border);background:var(--card);color:var(--text);display:flex;align-items:center;justify-content:center;cursor:pointer;transition:transform .15s ease,background .15s ease}
  .rowact:hover{transform:scale(1.08);background:var(--card2)}
  .rowact:active{transform:scale(.94)}
  .rowact.danger{color:#FF3B30}
  .sheet-bg{position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:60;display:flex;align-items:flex-end;justify-content:center}
  .sheet{width:100%;max-width:720px;max-height:92vh;overflow:auto;border-radius:24px 24px 0 0;padding:20px 20px 28px}
  .sheet.small{max-width:480px}
  .sheet-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}
  .sheet-head .muted2{color:var(--muted);font-size:12px;margin:4px 0 0;word-break:break-all}
  .editor{width:100%;min-height:320px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;line-height:1.6;margin-top:14px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:12px;padding:12px;resize:vertical}
  .sheet-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}
  .sheet-actions .btn{display:inline-flex;gap:6px;align-items:center}
  .perm{margin-top:16px;border:1px solid var(--border);border-radius:14px;padding:14px}
  .perm h4{margin:0 0 10px}
  .perm-grid{display:grid;grid-template-columns:1fr repeat(3,1fr);gap:8px;align-items:center;margin-bottom:12px}
  .perm-grid label{display:flex;justify-content:center}
  .perm-grid input{width:20px;height:20px;accent-color:var(--text)}
  .muted2{color:var(--muted);font-size:13px;margin:8px 0 0}
  .file-input-hidden{position:absolute;opacity:0;width:0;height:0;pointer-events:none}
  .dropzone{position:relative;display:flex;flex-direction:column;align-items:center;gap:6px;text-align:center;padding:20px 14px;border:1.5px dashed var(--border);border-radius:18px;background:rgba(255,255,255,.55);-webkit-backdrop-filter:blur(16px) saturate(160%);backdrop-filter:blur(16px) saturate(160%);cursor:pointer;transition:border-color .18s ease,transform .15s ease,box-shadow .18s ease;margin-top:10px}
  :global([data-theme="dark"]) .dropzone{background:rgba(28,28,30,.55)}
  .dropzone:hover{border-color:var(--text);transform:translateY(-1px);box-shadow:0 8px 24px rgba(0,0,0,.08)}
  .dropzone:active{transform:scale(.98)}
  .dropzone.drag{border-color:var(--text);border-style:solid;background:var(--card2);box-shadow:0 0 0 3px rgba(0,122,255,.18)}
  .dropicon{display:flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:13px;background:var(--text);color:var(--bg)}
  .dropzone b{font-size:15px}
  .dropsub{font-size:12px;color:var(--muted)}
  .droppick{display:inline-flex;gap:6px;align-items:center;margin-top:4px;pointer-events:none}
  .filechips{display:flex;flex-direction:column;gap:8px;margin-top:10px}
  .filechip{display:flex;gap:8px;align-items:center;background:var(--glass-bg);-webkit-backdrop-filter:blur(16px) saturate(160%);backdrop-filter:blur(16px) saturate(160%);border:1px solid var(--glass-border);border-radius:12px;padding:9px 10px}
  .chipname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:600}
  .filechip small{color:var(--muted);font-size:12px;flex:none}
  .chipx{width:24px;height:24px;flex:none;border-radius:8px;border:1px solid var(--border);background:var(--card);color:var(--text);font-size:16px;line-height:1;cursor:pointer}
  .chipx:hover{background:#FFF0F0;color:#FF3B30;border-color:#FF3B30}
  label{display:block;font-size:13px;font-weight:600;margin:12px 0 6px}
  code{background:var(--card2);padding:2px 6px;border-radius:6px;font-size:12px}
</style>
