import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
export default defineConfig({ plugins: [svelte()], server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:18099', '/app': 'http://127.0.0.1:18099', '/health': 'http://127.0.0.1:18099' } }, build: { outDir: 'dist', emptyOutDir: true, sourcemap: false } });
