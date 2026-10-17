<script>
  import Icon from './Icon.svelte';
  export let theme, onTheme, me, cfg, onLogout, onOpenBackup;
  function fmtUptime(s){ if(!s) return '-'; if(s<60) return s+' dtk'; if(s<3600) return Math.floor(s/60)+' mnt'; return (s/3600).toFixed(1)+' jam'; }
</script>

<div class="anim-slide-up">
  <h2 class="title">Pengaturan</h2>
  <p class="sub">Tema, info ControlPetro, backup, dan akun.</p>
  <div class="card"><h3>Tema</h3><div class="seg" style="margin-top:10px"><button class:active={theme === 'auto'} on:click={() => onTheme('auto')}>Otomatis</button><button class:active={theme === 'light'} on:click={() => onTheme('light')}>Terang</button><button class:active={theme === 'dark'} on:click={() => onTheme('dark')}>Gelap</button></div><p class="muted2" style="margin-top:10px">Otomatis mengikuti tema HP / laptop kamu.</p></div>
  <div class="card" style="margin-top:14px"><h3>Info ControlPetro</h3><p class="muted2">{#if cfg}Node {cfg.node} · Port {cfg.port} · Nyala {fmtUptime(cfg.bridgeUptimeSec)}<br />Apps di apps.json: {cfg.apps.length} · File: v3/server/apps.json{:else}Memuat...{/if}</p></div>
  <div class="card" style="margin-top:14px"><h3>Backup</h3><p class="muted2">Backup ControlPetro buat pindah panel.</p><button class="btn primary" on:click={() => onOpenBackup && onOpenBackup()} style="display:inline-flex;gap:6px;align-items:center;margin-top:8px"><Icon name="download" size={16} /> Backup</button></div>
  <div class="card" style="margin-top:14px"><h3>Akun</h3><p class="muted2">Login sebagai: {me || 'Memuat...'}</p><p class="muted2">Ubah password lewat panel File Manager lalu restart server.</p><button class="btn danger" on:click={onLogout} style="display:inline-flex;gap:6px;align-items:center;margin-top:8px"><Icon name="logout" size={16} /> Keluar</button></div>
</div>

<style>
  .title{font-size:24px;letter-spacing:-.02em;margin:4px 0 4px}
  .sub{color:var(--muted);font-size:14px;margin:0 0 16px}
  h3{margin:0 0 6px;font-size:16px}
  .muted2{color:var(--muted);font-size:13px;margin:8px 0 0}
</style>
