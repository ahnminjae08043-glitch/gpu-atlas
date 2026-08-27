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
    // WebGPU requires a secure context, so serving over plain http to a LAN
    // address leaves navigator.gpu undefined. Self-signed TLS makes testing on
    // phones and other devices on the network possible.
    plugins: [dts({ include: ['src'], rollupTypes: true }), basicSsl()],
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
