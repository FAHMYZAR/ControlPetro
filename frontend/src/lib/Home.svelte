<script>
  import { onMount, onDestroy } from 'svelte';
  import Icon from './Icon.svelte';
  export let apps = [], stats = null, onAct, onOpenSheet, onOpenLogs, onOpenFiles, onRefresh, onDelete, onSetup, onOpenTerm, onTogglePublic;
  function fmtBytes(n){ if(n==null) return '-'; if(n>1e9) return (n/1e9).toFixed(1)+' GB'; if(n>1e6) return (n/1e6).toFixed(0)+' MB'; if(n>1e3) return (n/1e3).toFixed(0)+' KB'; return n+' B'; }
  function fmtUptime(s){ if(!s) return '0 dtk'; if(s<60) return s+' dtk'; if(s<3600) return Math.floor(s/60)+' mnt'; return (s/3600).toFixed(1)+' jam'; }

  // Polling 2 detik milik Home: `live` jadi SATU sumber data untuk kartu monitoring + grafik.
  // Prop `stats` hanya dipakai sebagai data awal sebelum poll pertama selesai.
  let live = null;
  let pollTimer = null;
  async function pollStats() {
    try {
      const r = await fetch('/api/stats', { credentials: 'same-origin' });
      if (!r.ok) return;
      live = await r.json();
    } catch {}
  }
  $: view = live ?? stats;
  $: list = (live && live.apps) || apps;
  $: running = list.filter(a => a.status === 'running').length;
  $: memUsed = view && view.mem ? Math.round((1 - view.mem.free / view.mem.total) * 100) : 0;
  $: diskUsed = view && view.disk ? Math.round((1 - view.disk.free / view.disk.total) * 100) : 0;

  // ---- Monitor (grafik gelombang Task Manager style) ----
  let metric = 'ram'; // 'ram' | 'cpu' | 'disk'
  const PALETTE = ['#5b8cff', '#34c759', '#ff9500', '#af52de', '#ff3b30', '#ffd60a'];
  $: monitor = view?.monitor || null;
  $: history = (monitor && monitor.history) || [];
  $: latest = (monitor && monitor.latest) || {};
  $: appNames = [...new Set([...list.map(a => a.name), ...Object.keys(latest)])].sort();
  $: colorOf = Object.fromEntries(appNames.map((n, i) => [n, PALETTE[i % PALETTE.length]]));
  function fmtVal(v, m) { const x = v == null ? 0 : v; return m === 'cpu' ? x.toFixed(1) + '%' : x.toFixed(1) + ' MB'; }
  function rgba(hex, a) { const n = parseInt(hex.slice(1), 16); return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')'; }

  let canvasEl = null, wrapEl = null, ro = null, raf = 0;
  function drawSoon() { cancelAnimationFrame(raf); raf = requestAnimationFrame(draw); }
  function draw() {
    if (!canvasEl || !wrapEl) return;
    const dpr = window.devicePixelRatio || 1;
    const w = wrapEl.clientWidth, h = 180;
    if (!w) return;
    if (canvasEl.width !== Math.round(w * dpr) || canvasEl.height !== Math.round(h * dpr)) { canvasEl.width = Math.round(w * dpr); canvasEl.height = Math.round(h * dpr); }
    canvasEl.style.width = w + 'px';
    canvasEl.style.height = h + 'px';
    const ctx = canvasEl.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const padL = 8, padR = 8, padT = 26, padB = 16;
    const iw = w - padL - padR, ih = h - padT - padB;
    const grid = 'rgba(128,128,135,0.16)', label = 'rgba(128,128,135,0.9)';
    // Grid horizontal
    ctx.strokeStyle = grid; ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) { const y = padT + ih * i / 4; ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + iw, y); ctx.stroke(); }
    ctx.font = '11px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    if (!appNames.length) {
      ctx.fillStyle = label; ctx.textAlign = 'center';
      ctx.fillText('Belum ada app.', w / 2, h / 2);
      return;
    }
    if (!history.length) {
      ctx.fillStyle = label; ctx.textAlign = 'center';
      ctx.fillText('Mengumpulkan data...', w / 2, h / 2);
      return;
    }
    // Skala Y: max di seluruh history untuk metrik ini (min 1 biar tidak bagi 0).
    // Headroom 15% (scaleMax = max * 1.15) biar gelombang teratas tidak nempel ke tepi atas
    // dan label max tidak nabrak garisnya. Label tetap nampilin max asli.
    let max = 1;
    for (const p of history) for (const n of appNames) { const v = (p.apps && p.apps[n] && p.apps[n][metric]) || 0; if (v > max) max = v; }
    const scaleMax = max * 1.15;
    ctx.fillStyle = label;
    ctx.fillText(fmtVal(max, metric), padL, 13);
    ctx.fillText('0', padL, h - 3);
    // 1 gelombang per app
    for (const name of appNames) {
      const color = colorOf[name];
      const pts = history.map((p, i) => {
        const v = (p.apps && p.apps[name] && p.apps[name][metric]) || 0;
        const x = history.length === 1 ? padL + iw : padL + iw * i / (history.length - 1);
        const y = padT + ih - (v / scaleMax) * ih;
        return { x, y };
      });
      if (pts.length === 1) {
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.arc(pts[0].x, pts[0].y, 3, 0, Math.PI * 2); ctx.fill();
        continue;
      }
      // Isi gradient di bawah kurva
      const grad = ctx.createLinearGradient(0, padT, 0, padT + ih);
      grad.addColorStop(0, rgba(color, 0.22)); grad.addColorStop(1, rgba(color, 0));
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i].x + pts[i + 1].x) / 2, my = (pts[i].y + pts[i + 1].y) / 2;
        ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
      }
      ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
      ctx.save();
      ctx.lineTo(pts[pts.length - 1].x, padT + ih); ctx.lineTo(pts[0].x, padT + ih); ctx.closePath();
      ctx.fillStyle = grad; ctx.fill();
      ctx.restore();
      // Garis kurva halus (midpoint quadratic)
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i].x + pts[i + 1].x) / 2, my = (pts[i].y + pts[i + 1].y) / 2;
        ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
      }
      ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.stroke();
    }
  }
  $: { live; metric; if (canvasEl) drawSoon(); }
  onMount(() => {
    pollStats();
    pollTimer = setInterval(pollStats, 2000);
    if (wrapEl && window.ResizeObserver) { ro = new ResizeObserver(() => drawSoon()); ro.observe(wrapEl); }
  });
  onDestroy(() => {
    if (pollTimer) clearInterval(pollTimer);
    if (ro) ro.disconnect();
    cancelAnimationFrame(raf);
  });
</script>

<div class="anim-slide-up">
  <h2 class="title">Beranda</h2>
  <p class="sub">Ringkasan server dan app yang jalan.</p>
  <div class="grid2">
    <div class="card hoverable"><p class="lbl">App berjalan</p><div class="big">{running}<small> / {list.length}</small></div><p class="muted2">{list.length - running} berhenti</p></div>
    <div class="card hoverable"><p class="lbl">RAM terpakai</p><div class="big">{memUsed}<small>%</small></div><div class="progress"><div style="width:{memUsed}%"></div></div><p class="muted2">{view ? fmtBytes(view.mem.total - view.mem.free) + ' dari ' + fmtBytes(view.mem.total) : '-'}</p></div>
    <div class="card hoverable"><p class="lbl">ControlPetro nyala</p><div class="big">{view ? fmtUptime(view.bridgeUptimeSec) : '-'}</div><p class="muted2">Node {view ? view.node : '-'} · CPU {view ? view.cpuCount : '-'} core</p></div>
    <div class="card hoverable"><p class="lbl">Disk</p><div class="big">{diskUsed}<small>%</small></div><div class="progress"><div style="width:{diskUsed}%"></div></div><p class="muted2">{view && view.disk ? 'Sisa ' + fmtBytes(view.disk.free) + ' dari ' + fmtBytes(view.disk.total) : '-'}</p></div>
  </div>
  <div class="card monitor">
    <div class="mon-head">
      <h3>Pemakaian</h3>
      <div class="seg mon-seg">
        <button class:active={metric === 'ram'} on:click={() => metric = 'ram'}>RAM</button>
        <button class:active={metric === 'cpu'} on:click={() => metric = 'cpu'}>CPU</button>
        <button class:active={metric === 'disk'} on:click={() => metric = 'disk'}>Disk</button>
      </div>
    </div>
    <div class="mon-wrap" bind:this={wrapEl}>
      <canvas bind:this={canvasEl}></canvas>
    </div>
    {#if appNames.length}
      <div class="legend">
        {#each appNames as name}
          <span class="leg"><span class="legdot" style="background:{colorOf[name]}"></span><span class="legname">{name}</span><span class="legval">{fmtVal((latest[name] && latest[name][metric]) || 0, metric)}</span></span>
        {/each}
      </div>
    {/if}
  </div>
  <div class="actions">
    <button class="btn primary" on:click={onOpenSheet}><Icon name="plus" size={16} /> Tambah App</button>
    <button class="btn" on:click={onRefresh}><Icon name="refresh" size={16} /> Muat ulang</button>
  </div>
  <h3 class="sect">App berjalan</h3>
  <div class="list">
    {#if !list.length}<div class="card"><p>Belum ada app.</p></div>{/if}
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
  .grid2{display:grid;gap:12px;grid-template-columns:1fr 1fr}
  @media(max-width:600px){.grid2{gap:10px}}
  .lbl{margin:0 0 6px;color:var(--muted);font-size:13px}
  .big{font-size:28px;font-weight:800;letter-spacing:-.03em}
  .big small{font-size:13px;font-weight:400;color:var(--muted)}
  .muted2{color:var(--muted);font-size:13px;margin:8px 0 0}
  .progress{margin-top:10px}
  .actions{display:flex;gap:8px;margin:16px 0;flex-wrap:wrap}
  .actions .btn{display:inline-flex;gap:6px;align-items:center}
  .monitor{margin:16px 0 4px}
  .mon-head{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}
  .mon-head h3{margin:0;font-size:16px}
  .mon-seg{min-width:210px}
  .mon-wrap{margin-top:12px;width:100%}
  .mon-wrap canvas{display:block;width:100%;height:180px}
  .legend{display:grid;grid-template-columns:repeat(6,1fr);gap:8px 12px;margin-top:12px}
  @media(max-width:600px){.legend{grid-template-columns:repeat(3,1fr)}}
  .leg{display:flex;align-items:center;gap:5px;font-size:11px;min-width:0;font-weight:500}
  .legdot{width:7px;height:7px;border-radius:50%;flex:none}
  .legname{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
  .legval{color:var(--muted);font-size:10px;white-space:nowrap;flex:none}
  .sect{margin:18px 0 10px}
  .list{display:grid;gap:14px}
  .appcard{display:flex;flex-direction:column;gap:10px}
  .row1{display:flex;justify-content:space-between;gap:8px;align-items:center}
  .row1.clickable{cursor:pointer;border-radius:10px;padding:2px 4px;margin:-2px -4px}
  .row1.clickable:hover{background:var(--card2)}
  .row1.clickable b{text-decoration:underline;text-underline-offset:3px}
  .rowbtn{display:flex;gap:8px;flex-wrap:wrap}
  .rowbtn .btn{display:inline-flex;gap:6px;align-items:center}
  code{background:var(--card2);padding:2px 6px;border-radius:6px;font-size:12px}
</style>
