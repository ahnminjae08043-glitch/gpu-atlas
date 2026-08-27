import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

// mode=demo 는 데모 사이트를, 기본 build 는 라이브러리를 빌드한다.
export default defineConfig(({ mode }) => {
  if (mode === 'demo') {
    return {
      root: 'demo',
      build: { outDir: '../dist-demo', emptyOutDir: true },
    };
  }

  return {
    root: '.',
    plugins: [dts({ include: ['src'], rollupTypes: true })],
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
