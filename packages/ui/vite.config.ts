import path from 'node:path'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [tailwindcss(), svelte()],
  resolve: {
    alias: {
      $lib: path.resolve('./src/lib'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5601,
  },
  build: {
    outDir: 'dist',
  },
})
