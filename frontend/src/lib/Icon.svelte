<script>
  import { ICONS } from './icons.js';
  export let name = 'home';
  export let size = 22;
  export let spin = false;
</script>

<span class="ico" class:spin style="width:{size}px;height:{size}px">
  <svg viewBox="0 0 24 24" aria-hidden="true">{@html ICONS[name] || ICONS.home}</svg>
</span>
