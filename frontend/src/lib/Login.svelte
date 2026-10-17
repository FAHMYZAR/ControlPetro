<script>
  import { onMount, onDestroy } from 'svelte';
  import Icon from './Icon.svelte';
  export let onLogin;
  let username = 'admin', password = '', remember = true, show = false, err = '', busy = false, canvasEl, threeCleanup = null;

  async function initThree() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    try {
      const THREE = await import('three');
      if (!canvasEl) return;
      const renderer = new THREE.WebGLRenderer({ canvas: canvasEl, alpha: true, antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
      camera.position.z = 6;
      const N = 220, pos = new Float32Array(N * 3);
      for (let i = 0; i < N; i++) { pos[i*3] = (Math.random()-0.5)*10; pos[i*3+1] = (Math.random()-0.5)*7; pos[i*3+2] = (Math.random()-0.5)*4; }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const mat = new THREE.PointsMaterial({ color: 0x888888, size: 0.06, transparent: true, opacity: 0.7 });
      const points = new THREE.Points(geo, mat);
      scene.add(points);
      let raf = 0, t = 0, alive = true;
      function resize() { if (!canvasEl) return; const w = canvasEl.clientWidth || window.innerWidth, h = canvasEl.clientHeight || window.innerHeight; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }
      resize(); window.addEventListener('resize', resize);
      function tick() { if (!alive) return; t += 0.0022; points.rotation.y = t; points.rotation.x = Math.sin(t*0.7)*0.08; renderer.render(scene, camera); raf = requestAnimationFrame(tick); }
      tick();
      threeCleanup = () => { alive = false; cancelAnimationFrame(raf); window.removeEventListener('resize', resize); geo.dispose(); mat.dispose(); renderer.dispose(); };
    } catch (e) { /* fallback gradient CSS stays */ }
  }
  onMount(() => { initThree(); });
  onDestroy(() => { if (threeCleanup) threeCleanup(); });

  async function submit() {
    err = ''; busy = true;
    try {
      const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ username, password, remember }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'Login gagal');
      onLogin && onLogin(j);
    } catch (e) { err = e.message; }
    busy = false;
  }
</script>

<div class="login-wrap">
  <canvas bind:this={canvasEl} class="login-bg" aria-hidden="true"></canvas>
  <div class="login-grad" aria-hidden="true"></div>
  <div class="login-card glass-strong anim-pop">
    <img class="logo-img" src="/logo.png" alt="ControlPetro" />
    <h1>Selamat datang</h1>
    <p class="muted">Masuk ke ControlPetro untuk mengelola app kamu.</p>
    <form on:submit|preventDefault={submit}>
      <label>Username</label>
      <input bind:value={username} autocomplete="username" required />
      <label>Password</label>
      <div class="pwrow">
        {#if show}<input type="text" bind:value={password} autocomplete="current-password" required />{:else}<input type="password" bind:value={password} autocomplete="current-password" required />{/if}
        <button type="button" class="iconbtn pwbtn" on:click={() => show = !show} aria-label="Lihat password"><Icon name={show ? 'eyeOff' : 'eye'} size={18} /></button>
      </div>
      <label class="remember">
        <input type="checkbox" bind:checked={remember} class="remember-input" />
        <span class="checkbox" aria-hidden="true"><span class="checkmark"><Icon name="check" size={14} /></span></span>
        <span>Ingat saya</span>
        <span class="remember-hint">{remember ? '30 hari' : '1 hari'}</span>
      </label>
      {#if err}<div class="errbox">{err}</div>{/if}
      <button class="btn primary login-btn" type="submit" disabled={busy}>{#if busy}<span class="inline-block"><Icon name="refresh" size={16} spin={true} /></span> Masuk...{:else}Masuk{/if}</button>
    </form>
  </div>
</div>

<style>
  .login-wrap{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:20px;background:linear-gradient(160deg,#F2F2F4,#E5E5E7);overflow:hidden}
  :global([data-theme="dark"]) .login-wrap{background:linear-gradient(160deg,#0A0A0C,#1C1C1E)}
  .login-bg{position:absolute;inset:0;width:100%;height:100%}
  .login-grad{position:absolute;inset:0;background:radial-gradient(600px 300px at 20% 10%,rgba(52,199,89,.14),transparent 60%),radial-gradient(600px 300px at 85% 90%,rgba(0,122,255,.12),transparent 60%);pointer-events:none}
  .login-card{position:relative;z-index:2;width:100%;max-width:400px;border-radius:24px;padding:28px}
  .logo-img{width:72px;height:72px;border-radius:20px;object-fit:cover;margin-bottom:14px;box-shadow:0 8px 24px rgba(0,0,0,.12)}
  h1{margin:0 0 6px;font-size:26px;letter-spacing:-.02em}
  .muted{color:var(--muted);font-size:14px;margin:0 0 18px}
  label{display:block;font-size:13px;font-weight:600;margin:12px 0 6px}
  .pwrow{display:flex;gap:8px}
  .pwbtn{flex:none}
  .remember{display:flex;gap:10px;align-items:center;font-weight:400;color:var(--muted);cursor:pointer;margin-top:14px;user-select:none;-webkit-tap-highlight-color:transparent}
  .remember-input{position:absolute;opacity:0;width:0;height:0;pointer-events:none}
  .remember:focus-within .checkbox{box-shadow:0 0 0 3px rgba(0,122,255,.28)}
  .checkbox{width:22px;height:22px;flex:none;border-radius:7px;border:1.5px solid var(--border);background:rgba(255,255,255,.65);backdrop-filter:blur(12px) saturate(160%);display:flex;align-items:center;justify-content:center;transition:background .18s ease,border-color .18s ease,transform .15s ease,box-shadow .18s ease;box-shadow:inset 0 1px 0 rgba(255,255,255,.5)}
  :global([data-theme="dark"]) .checkbox{background:rgba(28,28,30,.65);box-shadow:inset 0 1px 0 rgba(255,255,255,.08)}
  .remember:hover .checkbox{border-color:var(--text);transform:scale(1.06)}
  .remember:active .checkbox{transform:scale(.94)}
  .checkmark{display:flex;align-items:center;justify-content:center;color:var(--bg);opacity:0;transform:scale(.4);transition:opacity .16s ease,transform .18s cubic-bezier(.34,1.56,.64,1)}
  .remember-input:checked + .checkbox{background:var(--text);border-color:var(--text)}
  .remember-input:checked + .checkbox .checkmark{opacity:1;transform:scale(1)}
  .remember-hint{margin-left:auto;font-size:12px;color:var(--muted)}
  .errbox{background:#FFF0F0;color:#C00;border-radius:10px;padding:10px 12px;font-size:13px;margin-top:12px}
  .login-btn{width:100%;margin-top:16px;padding:13px}
  .hint{color:var(--muted);font-size:12px;margin:14px 0 0;text-align:center}
  code{background:var(--card2);padding:2px 6px;border-radius:6px}
  .inline-block{display:inline-block}
</style>
