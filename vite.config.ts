import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import basicSsl from '@vitejs/plugin-basic-ssl';

// mode=demo builds the demo site; the default build produces the library.
export default defineConfig(({ mode }) => {
  if (mode === 'demo') {
    return {
      root: 'demo',
      // Served from a repository subpath on GitHub Pages.
      base: process.env.DEMO_BASE ?? '/',
      build: { outDir: '../dist-demo', emptyOutDir: true },
    };
  }

  return {
    root: '.',
    // localhost is a secure context over plain http, so TLS is off by default —
    // a self-signed certificate only adds an interstitial to click through.
    // Set HTTPS=1 to serve over TLS when testing from another device on the LAN
    // without going through the deployed demo.
    plugins: [
      dts({ include: ['src'], rollupTypes: true }),
      ...(process.env.HTTPS ? [basicSsl()] : []),
    ],
    build: {
      lib: {
        entry: 'src/index.ts',
        name: 'GpuAtlas',
        formats: ['es'],
        fileName: () => 'gpu-atlas.js',
      },
      sourcemap: true,
      target: 'es2022',
    },
    server: { open: '/demo/' },
  };
});
