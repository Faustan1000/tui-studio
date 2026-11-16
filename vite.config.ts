import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

// https://vite.dev/config/
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(process.env.VITE_APP_VERSION || pkg.version),
  },
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    watch: {
      // Files the editor or the preview script write (saved projects, exported apps with their
      // node_modules/target) are not part of the app: a change there must not reload the page,
      // which would throw away the open project.
      ignored: ['**/*.tui', '**/examples/**', '**/preview/**', '**/tests/**', '**/scripts/**'],
    },
  },
  build: {
    // The exporters (code generators and the runtimes they write) are one chunk of about 600 kB
    // that is only loaded when the export dialog opens.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
      },
      output: {
        // Libraries that change rarely go into their own files, which the browser keeps cached.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (/node_modules\/(react|react-dom|react-router|react-router-dom|scheduler)\//.test(id))
            return 'react';
          if (id.includes('lucide-react')) return 'icons';
          return 'vendor';
        },
      },
    },
  },
});
