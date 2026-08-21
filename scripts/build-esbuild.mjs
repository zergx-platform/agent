import { build } from 'esbuild'
import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const cwd = process.cwd()

// Remove previously emitted JS/maps so stale files don't linger.
for (const f of readdirSync(join(cwd, 'dist'))) {
  if (f.endsWith('.js') || f.endsWith('.js.map')) {
    rmSync(join(cwd, 'dist', f), { force: true })
  }
}

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'dist/index.js',
  packages: 'external',
  loader: { '.txt': 'text' },
  logLevel: 'info',
})
