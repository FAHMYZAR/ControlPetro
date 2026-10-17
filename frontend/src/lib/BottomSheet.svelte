<script>
  import { fly, fade } from 'svelte/transition';
  import { tick } from 'svelte';
  import Icon from './Icon.svelte';
  // Wizard Tambah App 3 tab: 1 Project, 2 Instalasi, 3 Deploy.
  // - Buat baru: Tab 1 buat project (app BERHENTI), Tab 2 install dengan log live, Tab 3 deploy.
  // - Edit (editApp): lewati Tab 1 (read-only), langsung Tab 2 install + Tab 3 deploy.
  // - Kalau wizard ditutup di tengah setelah Tab 1, app tetap ada dalam keadaan berhenti.
  export let open = false, apps = [], onCreated, onClose, editApp = null;
  let tab = 1;
  let createdName = '';
  let detect = null;
  // Tab 1
  let source = 'git', name = '', desc = '', stack = 'node', customCommand = '', port = 3101, gitUrl = '', gitBranch = '', template = 'node';
  let pickedFiles = [], dragOver = false, fileInputEl = null, fileListText = 'Belum ada file dipilih.';
  // Tab 2
  let installCommand = '', installStatus = 'idle', installLogs = [], pollTimer = null, logEl = null, installBusy = false;
  // Tab 3
  let startCommand = '', buildCommand = '', portMode = 'auto', envText = '', auto = true;
  let err = '', busy = false, prevOpen = false;
  $: usedPorts = new Set(apps.map(a => a.port));
  $: pickedTotal = pickedFiles.reduce((s, f) => s + (f.size || 0), 0);
  $: pickedOver = pickedTotal > 100 * 1024 * 1024;
  $: canDeploy = installStatus === 'done' || installStatus === 'skipped';
  $: steps = [{ n: 1, label: 'Project' }, { n: 2, label: 'Instalasi' }, { n: 3, label: 'Deploy' }];
  function stackCommand(s) {
    if (s === 'node') return 'node server.cjs';
    if (s === 'npm') return 'npm start';
    if (s === 'python') return 'python3 app.py';
    if (s === 'static') return 'node server.cjs';
    if (s === 'custom') return customCommand.trim();
    return 'node server.cjs';
  }
  function computeAutoPort(excludeName) {
    const used = new Set(apps.filter(a => a.name !== excludeName).map(a => a.port));
    let p = 3101; while (used.has(p)) p++; return p;
  }
  function parseEnv(txt) { const env = {}; (txt || '').split('\n').forEach(line => { line = line.trim(); if (!line) return; const ix = line.indexOf('='); if (ix > 0) env[line.slice(0, ix).trim()] = line.slice(ix + 1).trim(); }); return env; }
  function envToText(env) { return Object.entries(env || {}).map(([k, v]) => k + '=' + v).join('\n'); }
  function close() { stopPoll(); open = false; if (onClose) onClose(); }
  function onKey(e) { if (e.key === 'Escape') close(); }
  function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
  async function pollInstall() {
    if (!createdName) return;
    try {
      const r = await fetch('/api/apps/' + encodeURIComponent(createdName) + '/install', { credentials: 'same-origin' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return;
      installStatus = j.status || installStatus;
      installLogs = Array.isArray(j.logs) ? j.logs : [];
      await tick();
      if (logEl) logEl.scrollTop = logEl.scrollHeight;
      if (installStatus === 'done' || installStatus === 'failed') { stopPoll(); installBusy = false; }
    } catch {}
  }
  function startPoll() { stopPoll(); pollTimer = setInterval(pollInstall, 1000); }
  async function fetchDetect(nm) {
    try {
      const r = await fetch('/api/apps/' + encodeURIComponent(nm) + '/detect', { credentials: 'same-origin' });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.detect) { detect = j.detect; return j.detect; }
    } catch {}
    return null;
  }
  function resetNew() {
    tab = 1; createdName = ''; detect = null;
    source = 'git'; name = ''; desc = ''; stack = 'node'; customCommand = ''; port = computeAutoPort(null);
    gitUrl = ''; gitBranch = ''; template = 'node';
    pickedFiles = []; fileListText = 'Belum ada file dipilih.';
    installCommand = ''; installStatus = 'idle'; installLogs = [];
    startCommand = ''; buildCommand = ''; portMode = 'auto'; envText = ''; auto = true;
    err = ''; busy = false; installBusy = false;
  }
  async function loadEdit(nm) {
    tab = 2; createdName = nm; name = nm; err = '';
    installStatus = 'idle'; installLogs = [];
    try {
      const r = await fetch('/api/config', { credentials: 'same-origin' });
      const j = await r.json().catch(() => ({}));
      const cfg = (j.apps || []).find(a => a.name === nm);
      if (cfg) {
        desc = cfg.description || ''; stack = cfg.stack || 'node';
        startCommand = cfg.command || ''; port = Number(cfg.port) || 3101; portMode = 'manual';
        envText = envToText(cfg.env || {}); auto = cfg.autostart !== false;
        installCommand = cfg.installCommand || ''; buildCommand = cfg.buildCommand || '';
      }
    } catch {}
    const d = await fetchDetect(nm);
    if (d) {
      if (!installCommand) installCommand = d.suggestedInstall || '';
      if (!startCommand) startCommand = d.suggestedStart || '';
      if (!buildCommand) buildCommand = d.suggestedBuild || '';
    }
    try {
      const r = await fetch('/api/apps/' + encodeURIComponent(nm) + '/install', { credentials: 'same-origin' });
      const j = await r.json().catch(() => ({}));
      if (r.ok) { installStatus = j.status || 'idle'; installLogs = Array.isArray(j.logs) ? j.logs : []; }
    } catch {}
  }
  function initWizard() { if (editApp) loadEdit(editApp); else resetNew(); }
  $: if (open && !prevOpen) { prevOpen = true; initWizard(); } else if (!open && prevOpen) { prevOpen = false; stopPoll(); }
  function tryGoTab(n) {
    if (n < tab) { tab = n; return; }
    if (n === tab) return;
    if (n === 2 && createdName) { tab = 2; return; }
    if (n === 3 && createdName && canDeploy) { tab = 3; return; }
  }
  // ---- Tab 1: file picker (multipart, sama seperti sebelumnya) ----
  function refreshFileListText() {
    fileListText = pickedFiles.length ? pickedFiles.length + ' file dipilih — total ' + (pickedTotal > 1024 * 1024 ? (pickedTotal / 1024 / 1024).toFixed(1) + ' MB' : Math.round(pickedTotal / 1024) + ' KB') : 'Belum ada file dipilih.';
    if (pickedOver) fileListText += ' — MELEBIHI 100 MB, kurangi file.';
  }
  function handlePicked(list) {
    const arr = Array.from(list || []);
    for (const f of arr) { if (!pickedFiles.some(x => x.name === f.name && x.size === f.size)) pickedFiles.push(f); }
    pickedFiles = [...pickedFiles]; refreshFileListText();
  }
  function onFiles(e) { handlePicked(e.target.files); if (fileInputEl) fileInputEl.value = ''; }
  function onDrop(e) { dragOver = false; handlePicked(e.dataTransfer.files); }
  function removePicked(i) { pickedFiles.splice(i, 1); pickedFiles = [...pickedFiles]; refreshFileListText(); }
  function fileIcon(nm) {
    const n = (nm || '').toLowerCase();
    if (/\.(js|cjs|mjs|ts|json|html|css|py|sh)$/.test(n)) return 'fileCode';
    if (/\.(txt|md)$/.test(n)) return 'fileText';
    if (/\.(png|jpg|jpeg|gif|webp|svg)$/.test(n)) return 'fileImage';
    return 'file';
  }
  // ---- Tab 1 submit: buat project BERHENTI (wizard=true), lanjut ke Tab 2 ----
  async function submitProject() {
    err = '';
    const nm = name.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(nm)) { err = 'Nama tidak valid: huruf kecil / angka / strip, awali huruf/angka, maks 31 karakter.'; return; }
    if (apps.some(a => a.name === nm)) { err = 'Nama sudah dipakai app lain.'; return; }
    const cmd = stackCommand(stack);
    if (!cmd) { err = 'Command wajib diisi (stack Custom).'; return; }
    const allocPort = computeAutoPort(null);
    if (source === 'git' && !gitUrl.trim().startsWith('https://')) { err = 'URL Git harus diawali https://'; return; }
    if (source === 'upload') {
      if (!pickedFiles.length) { err = 'Pilih minimal 1 file untuk di-upload.'; return; }
      if (pickedTotal > 100 * 1024 * 1024) { err = 'Total file melebihi 100 MB.'; return; }
    }
    busy = true;
    try {
      let r;
      if (source === 'upload') {
        const fd = new FormData();
        fd.append('name', nm); fd.append('description', desc.trim()); fd.append('stack', stack);
        fd.append('port', String(allocPort)); fd.append('command', cmd);
        fd.append('env', JSON.stringify({})); fd.append('autostart', 'false');
        fd.append('wizard', 'true'); fd.append('installCommand', ''); fd.append('buildCommand', '');
        fd.append('sourceType', 'upload');
        for (const f of pickedFiles) fd.append('files', f, f.name);
        r = await fetch('/api/apps/create', { method: 'POST', credentials: 'same-origin', body: fd });
      } else {
        const payload = { name: nm, description: desc.trim(), stack, port: allocPort, command: cmd, env: {}, autostart: false, wizard: true, installCommand: '', buildCommand: '', source: { type: source } };
        if (source === 'git') { payload.source.url = gitUrl.trim(); payload.source.branch = gitBranch.trim() || ''; }
        if (source === 'empty') payload.source.template = template;
        r = await fetch('/api/apps/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(payload) });
      }
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'Gagal membuat project');
      createdName = nm; port = allocPort; portMode = 'auto';
      // Deteksi dari response, atau fetch ulang.
      detect = j.detect || await fetchDetect(nm);
      if (detect) {
        installCommand = detect.suggestedInstall || '';
        startCommand = detect.suggestedStart || cmd;
        buildCommand = detect.suggestedBuild || '';
      } else {
        startCommand = cmd;
      }
      // Port sebenarnya dari server (kalau backend auto-assign).
      try {
        const rc = await fetch('/api/apps/' + encodeURIComponent(nm), { credentials: 'same-origin' });
        const jc = await rc.json().catch(() => ({}));
        if (rc.ok && jc.app && jc.app.port) port = Number(jc.app.port);
      } catch {}
      installStatus = 'idle'; installLogs = [];
      tab = 2;
    } catch (e) { err = e.message; }
    busy = false;
  }
  // ---- Tab 2: instalasi ----
  async function runInstall() {
    err = '';
    if (!createdName) return;
    if (!installCommand.trim()) { err = 'Install Command wajib diisi, atau pakai Lewati Install kalau memang tidak perlu install.'; return; }
    installBusy = true; installStatus = 'running'; installLogs = ['Menjalankan: ' + installCommand.trim()];
    try {
      const r = await fetch('/api/apps/' + encodeURIComponent(createdName) + '/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ command: installCommand.trim() }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'Gagal menjalankan install');
      startPoll();
    } catch (e) { err = e.message; installStatus = 'failed'; installBusy = false; }
  }
  function skipInstall() { installStatus = 'skipped'; stopPoll(); tab = 3; }
  // ---- Tab 3: deploy ----
  async function submitDeploy() {
    err = '';
    if (!createdName) return;
    const finalPort = portMode === 'auto' ? port : Number(port);
    if (!finalPort || finalPort < 3101 || finalPort > 3999) { err = 'Port harus 3101-3999.'; return; }
    if (apps.some(a => a.name !== createdName && Number(a.port) === finalPort)) { err = 'Port sudah dipakai app lain.'; return; }
    if (!startCommand.trim()) { err = 'Start Command wajib diisi.'; return; }
    busy = true;
    try {
      const r = await fetch('/api/apps/' + encodeURIComponent(createdName) + '/deploy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ port: finalPort, command: startCommand.trim(), buildCommand: buildCommand.trim(), env: parseEnv(envText), autostart: auto, installCommand: installCommand.trim() }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'Gagal deploy');
      const nm = createdName;
      close(); if (onCreated) onCreated(nm);
    } catch (e) { err = e.message; }
    busy = false;
  }
</script>

<svelte:window on:keydown={onKey} />
{#if open}
  <div class="sheet-bg" transition:fade={{ duration: 180 }} on:click={(e) => { if (e.target === e.currentTarget) close(); }}>
    <div class="sheet glass-strong" transition:fly={{ y: 80, duration: 320 }}>
      <div class="handle"></div>
      <div class="sheet-head"><h2>{editApp ? 'Setup Aplikasi' : 'Tambah Aplikasi'}</h2><button class="iconbtn" on:click={close} aria-label="Tutup"><Icon name="close" size={18} /></button></div>
      <p class="sub">{editApp ? 'Instalasi dan deploy ulang untuk app ' + editApp + '.' : 'Buat project, install, lalu deploy. App dibuat berhenti dulu, baru jalan setelah deploy.'}</p>
      <!-- Stepper -->
      <div class="stepper">
        {#each steps as s}
          <button type="button" class="step" class:active={tab === s.n} class:done={tab > s.n || (s.n === 1 && !!createdName) || (s.n === 2 && canDeploy)} on:click={() => tryGoTab(s.n)}>
            <span class="stepnum">{#if tab > s.n || (s.n === 1 && !!createdName) || (s.n === 2 && canDeploy)}<Icon name="check" size={14} />{:else}{s.n}{/if}</span>
            <span class="steplabel2">{s.label}</span>
          </button>
          {#if s.n < 3}<span class="stepline" class:done={tab > s.n}></span>{/if}
        {/each}
      </div>

      <!-- ============ TAB 1: PROJECT ============ -->
      {#if tab === 1}
        {#if editApp}
          <div class="card flat"><p class="muted2">Project</p><h3 style="margin:4px 0">{createdName}</h3><p class="muted2">{desc || ''}</p><p class="muted2">Stack: {stack} · Port: {port}</p></div>
          <div class="sheet-foot"><button type="button" class="btn" style="flex:1" on:click={close}>Batal</button><button type="button" class="btn primary" style="flex:2" on:click={() => tab = 2}>Lanjut ke Instalasi</button></div>
        {:else}
          <div class="steplabel">1. Sumber aplikasi</div>
          <div class="sourcegrid">
            <button type="button" class="srccard" class:sel={source === 'git'} on:click={() => source = 'git'}><Icon name="git" size={28} /><b>Clone dari Git</b><span>Ambil repo GitHub / GitLab.</span></button>
            <button type="button" class="srccard" class:sel={source === 'upload'} on:click={() => source = 'upload'}><Icon name="upload" size={28} /><b>Upload File</b><span>Upload file project dari HP / laptop.</span></button>
            <button type="button" class="srccard" class:sel={source === 'empty'} on:click={() => source = 'empty'}><Icon name="plusBox" size={28} /><b>Mulai Kosong</b><span>Buat dari template hello world.</span></button>
          </div>
          {#if source === 'git'}
            <label>URL Git <span>misal https://github.com/user/repo.git</span></label>
            <input bind:value={gitUrl} type="text" placeholder="https://github.com/user/repo.git" />
            <label>Branch <span>kosongkan = default repo</span></label>
            <input bind:value={gitBranch} type="text" placeholder="main" />
          {/if}
          {#if source === 'upload'}
            <label>File project <span>bisa banyak file, maks total 100 MB</span></label>
            <div class="dropzone" class:drag={dragOver} role="button" tabindex="0" title="Pilih file"
              on:click={() => fileInputEl && fileInputEl.click()}
              on:keydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInputEl && fileInputEl.click(); } }}
              on:dragover|preventDefault={() => dragOver = true}
              on:dragleave={() => dragOver = false}
              on:drop|preventDefault={onDrop}>
              <input bind:this={fileInputEl} type="file" multiple on:change={onFiles} class="file-input-hidden" />
              <span class="dropicon"><Icon name="upload" size={28} /></span>
              <b>{pickedFiles.length ? pickedFiles.length + ' file dipilih' : 'Pilih file project'}</b>
              <span class="dropsub">Klik atau tarik file ke sini · maks total 100 MB</span>
              <span class="btn small primary droppick"><Icon name="plus" size={14} /> Pilih File</span>
            </div>
            {#if pickedFiles.length}
              <div class="filechips">
                {#each pickedFiles as f, i}
                  <div class="filechip"><Icon name={fileIcon(f.name)} size={16} /><span class="chipname">{f.name}</span><small>{Math.round(f.size / 1024)} KB</small><button type="button" class="chipx" on:click|stopPropagation={() => removePicked(i)} aria-label="Hapus {f.name}">×</button></div>
                {/each}
              </div>
              <div class="filelist" class:over={pickedOver}>{fileListText}</div>
            {:else}
              <div class="filelist">{fileListText}</div>
            {/if}
          {/if}
          {#if source === 'empty'}
            <label>Template</label>
            <select bind:value={template}><option value="node">Hello Node.js (server.cjs)</option><option value="python">Hello Python (app.py)</option><option value="blank">Kosong saja (folder kosong)</option></select>
          {/if}
          <label>Nama aplikasi <span>huruf kecil, angka, strip. Jadi slug dan folder.</span></label>
          <input bind:value={name} type="text" placeholder="misal: bot-wa, web-toko" />
          {#if name && !/^[a-z0-9][a-z0-9-]{0,30}$/.test(name.trim().toLowerCase())}<div class="errbox">Nama belum valid.</div>{/if}
          <label>Deskripsi <span>opsional</span></label>
          <input bind:value={desc} type="text" placeholder="misal: Bot WA toko" />
          <label>Stack</label>
          <select bind:value={stack}>
            <option value="node">Node.js — jalanin node server.cjs</option>
            <option value="npm">Node.js (npm start) — pakai package.json</option>
            <option value="python">Python — jalanin python3 app.py</option>
            <option value="static">Static — serve file HTML (pakai node server.cjs)</option>
            <option value="custom">Custom — isi command sendiri di Tab 3</option>
          </select>
          {#if stack === 'custom'}
            <label>Command awal <span>dipakai sementara, bisa diubah di Tab Deploy</span></label>
            <input bind:value={customCommand} type="text" placeholder="misal: npm start" />
          {/if}
          {#if err}<div class="errbox">{err}</div>{/if}
          <div class="sheet-foot"><button type="button" class="btn" style="flex:1" on:click={close}>Batal</button><button type="button" class="btn primary" style="flex:2" disabled={busy} on:click={submitProject}>{#if busy}<Icon name="refresh" size={16} spin={true} /> Membuat...{:else}Buat Project &amp; Lanjut{/if}</button></div>
        {/if}
      {/if}

      <!-- ============ TAB 2: INSTALASI ============ -->
      {#if tab === 2}
        <div class="steplabel">Project: <b>{createdName}</b></div>
        {#if detect}
          <div class="detectbox">
            {#if detect.hasPackageJson}<p><Icon name="fileCode" size={15} /> Terdeteksi <b>package.json</b>{#if detect.packageJson && detect.packageJson.scripts && detect.packageJson.scripts.start} · script start ada{:else} · tidak ada script start{/if}</p>
            {:else if detect.hasRequirements}<p><Icon name="fileCode" size={15} /> Terdeteksi <b>requirements.txt</b></p>
            {:else if detect.hasPipfile}<p><Icon name="fileCode" size={15} /> Terdeteksi <b>Pipfile</b></p>
            {:else}<p><Icon name="file" size={15} /> Tidak ada file dependensi (package.json / requirements.txt).</p>{/if}
          </div>
        {/if}
        <label>Install Command <span>diisi otomatis dari deteksi, bisa diedit</span></label>
        <input bind:value={installCommand} type="text" placeholder="misal: npm install" />
        <div class="install-actions">
          <button type="button" class="btn primary" disabled={installBusy || installStatus === 'running'} on:click={runInstall}>{#if installStatus === 'running'}<Icon name="refresh" size={15} spin={true} /> Menginstall...{:else}<Icon name="download" size={15} /> Jalankan Install{/if}</button>
          <button type="button" class="btn" on:click={skipInstall}>Lewati Install</button>
          {#if installStatus === 'failed'}<button type="button" class="btn" on:click={runInstall}>Install Ulang</button>{/if}
        </div>
        <div class="statusrow">
          <span>Status:</span>
          {#if installStatus === 'idle'}<span class="pill">Belum install</span>
          {:else if installStatus === 'running'}<span class="pill"><span class="dot running"></span> Lagi install...</span>
          {:else if installStatus === 'done'}<span class="pill"><span class="dot running"></span> Install sukses</span>
          {:else if installStatus === 'failed'}<span class="pill"><span class="dot stopped"></span> Install gagal</span>
          {:else if installStatus === 'skipped'}<span class="pill">Dilewati</span>{/if}
        </div>
        <div class="logbox" bind:this={logEl}>
          {#if !installLogs.length}<span class="muted2">Log install akan muncul di sini setelah Jalankan Install.</span>
          {:else}{#each installLogs as line}<div class="logline">{line}</div>{/each}{/if}
        </div>
        {#if err}<div class="errbox">{err}</div>{/if}
        <div class="sheet-foot"><button type="button" class="btn" style="flex:1" on:click={() => tab = 1}>Kembali</button><button type="button" class="btn primary" style="flex:2" disabled={!canDeploy} on:click={() => tab = 3}>Lanjut ke Deploy</button></div>
      {/if}

      <!-- ============ TAB 3: DEPLOY ============ -->
      {#if tab === 3}
        <div class="steplabel">Project: <b>{createdName}</b></div>
        <label>Start Command <span>perintah yang dijalankan saat deploy</span></label>
        <input bind:value={startCommand} type="text" placeholder="misal: npm start" />
        <label>Build Command <span>opsional, misal: npm run build. Dijalankan sebelum start, kalau gagal deploy dibatalkan.</span></label>
        <input bind:value={buildCommand} type="text" placeholder="kosongkan kalau tidak perlu build" />
        <label>Port internal</label>
        <div class="radiorow">
          <label class="radio"><input type="radio" bind:group={portMode} value="auto" /> Auto (pakai {port})</label>
          <label class="radio"><input type="radio" bind:group={portMode} value="manual" /> Manual</label>
        </div>
        {#if portMode === 'manual'}
          <div class="portrow"><input bind:value={port} type="number" min="3101" max="3999" placeholder="3101" /></div>
        {/if}
        <p class="muted2">Port 3101-3999, unik per app. ControlPetro yang nge-proxy ke port publik.</p>
        <label>Environment <span>opsional, 1 baris per variabel: KEY=value</span></label>
        <textarea bind:value={envText} rows="3" placeholder="API_KEY=xxx\nDEBUG=1"></textarea>
        <label class="autorow"><span class="switch"><input type="checkbox" bind:checked={auto} /><span class="slider"></span></span> Auto-start saat bridge nyala</label>
        {#if err}<div class="errbox">{err}</div>{/if}
        <div class="sheet-foot"><button type="button" class="btn" style="flex:1" on:click={() => tab = 2}>Kembali</button><button type="button" class="btn primary" style="flex:2" disabled={busy} on:click={submitDeploy}>{#if busy}<Icon name="refresh" size={16} spin={true} /> Deploy...{:else}<Icon name="play" size={16} /> Deploy &amp; Jalankan{/if}</button></div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .sheet-bg{position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:60;display:flex;align-items:flex-end;justify-content:center}
  .sheet{width:100%;max-width:620px;max-height:92vh;overflow:auto;background:var(--glass-bg-strong);border-radius:24px 24px 0 0;padding:8px 20px 28px;position:relative}
  .handle{width:44px;height:5px;border-radius:99px;background:var(--border);margin:6px auto 14px}
  .sheet-head{display:flex;justify-content:space-between;align-items:center}
  h2{margin:0;font-size:24px}
  .sub{color:var(--muted);font-size:14px;margin:8px 0 16px}
  .steplabel{font-size:13px;font-weight:600;margin:0 0 6px}
  .stepper{display:flex;align-items:center;gap:6px;margin:0 0 18px}
  .step{display:flex;align-items:center;gap:6px;background:none;border:none;cursor:pointer;padding:4px 2px;color:var(--muted)}
  .step.active{color:var(--text);font-weight:700}
  .step.done{color:var(--text)}
  .stepnum{display:flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:99px;border:1.5px solid currentColor;font-size:12px;font-weight:700;flex:none}
  .step.active .stepnum{background:var(--text);color:var(--bg);border-color:var(--text)}
  .step.done .stepnum{background:var(--text);color:var(--bg);border-color:var(--text)}
  .steplabel2{font-size:12px}
  .stepline{flex:1;height:2px;background:var(--border);border-radius:99px}
  .stepline.done{background:var(--text)}
  .sourcegrid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px}
  @media(max-width:520px){.sourcegrid{grid-template-columns:1fr}}
  .srccard b{display:block;font-size:14px}
  .srccard span{color:var(--muted);font-size:12px}
  label{display:block;font-size:13px;font-weight:600;margin:14px 0 6px}
  label span{font-weight:400;color:var(--muted)}
  .filelist{font-size:13px;color:var(--muted);margin-top:6px}
  .filelist.over{color:#FF3B30;font-weight:600}
  .file-input-hidden{position:absolute;opacity:0;width:0;height:0;pointer-events:none}
  .dropzone{position:relative;display:flex;flex-direction:column;align-items:center;gap:6px;text-align:center;padding:22px 16px;border:1.5px dashed var(--border);border-radius:18px;background:rgba(255,255,255,.55);-webkit-backdrop-filter:blur(16px) saturate(160%);backdrop-filter:blur(16px) saturate(160%);cursor:pointer;transition:border-color .18s ease,transform .15s ease,box-shadow .18s ease}
  :global([data-theme="dark"]) .dropzone{background:rgba(28,28,30,.55)}
  .dropzone:hover{border-color:var(--text);transform:translateY(-1px);box-shadow:0 8px 24px rgba(0,0,0,.08)}
  .dropzone:active{transform:scale(.98)}
  .dropzone.drag{border-color:var(--text);border-style:solid;background:var(--card2);box-shadow:0 0 0 3px rgba(0,122,255,.18)}
  .dropicon{display:flex;align-items:center;justify-content:center;width:48px;height:48px;border-radius:14px;background:var(--text);color:var(--bg)}
  .dropzone b{font-size:15px}
  .dropsub{font-size:12px;color:var(--muted)}
  .droppick{display:inline-flex;gap:6px;align-items:center;margin-top:4px;pointer-events:none}
  .filechips{display:flex;flex-direction:column;gap:8px;margin-top:10px}
  .filechip{display:flex;gap:8px;align-items:center;background:var(--glass-bg);-webkit-backdrop-filter:blur(16px) saturate(160%);backdrop-filter:blur(16px) saturate(160%);border:1px solid var(--glass-border);border-radius:12px;padding:9px 10px}
  .chipname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:600}
  .filechip small{color:var(--muted);font-size:12px;flex:none}
  .chipx{width:24px;height:24px;flex:none;border-radius:8px;border:1px solid var(--border);background:var(--card);color:var(--text);font-size:16px;line-height:1;cursor:pointer}
  .chipx:hover{background:#FFF0F0;color:#FF3B30;border-color:#FF3B30}
  .portrow{display:flex;gap:8px}
  .autorow{display:flex;gap:10px;align-items:center;font-weight:400}
  .errbox{background:#FFF0F0;color:#C00;border-radius:10px;padding:10px 12px;font-size:13px;margin-top:12px}
  .sheet-foot{display:flex;gap:10px;margin-top:18px}
  .sheet-foot .btn{display:inline-flex;gap:6px;align-items:center;justify-content:center}
  .card.flat{background:var(--glass-bg);border:1px solid var(--glass-border);border-radius:14px;padding:14px;margin-bottom:12px}
  .muted2{color:var(--muted);font-size:13px;margin:8px 0 0}
  .detectbox{background:var(--glass-bg);border:1px solid var(--glass-border);border-radius:12px;padding:12px;margin:8px 0}
  .detectbox p{display:flex;gap:8px;align-items:center;margin:0;font-size:13px}
  .install-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
  .install-actions .btn{display:inline-flex;gap:6px;align-items:center}
  .statusrow{display:flex;gap:8px;align-items:center;margin:14px 0 8px;font-size:13px}
  .pill{display:inline-flex;gap:6px;align-items:center;background:var(--card2);border-radius:99px;padding:4px 10px;font-size:12px}
  .dot{width:8px;height:8px;border-radius:99px;background:var(--muted);display:inline-block}
  .dot.running{background:#34C759}
  .dot.stopped{background:#FF3B30}
  .logbox{background:#0A0A0C;color:#E5E5EA;border-radius:12px;padding:12px;min-height:180px;max-height:280px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word}
  .logbox .muted2{color:#8E8E93}
  .logline{margin:0}
  .radiorow{display:flex;gap:16px;margin:6px 0}
  .radio{display:flex;gap:6px;align-items:center;font-weight:400;margin:0}
  .radio input{width:16px;height:16px;accent-color:var(--text)}
</style>
