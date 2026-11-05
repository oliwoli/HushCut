import {defineConfig} from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'; // Make sure you have this import
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


// https://vitejs.dev/config/
export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: Number(process.env.WAILS_VITE_PORT) || 9245,
    strictPort: true,
  },
  plugins: [
    react(), // Uses Babel with .babelrc or babel.config.js
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@wails/go/main/App': path.resolve(__dirname, './bindings/github.com/oliwoli/hushcut/app.ts'),
      '@wails/go/models': path.resolve(__dirname, './src/lib/models-adapter.ts'),
      '@wails/runtime/runtime': path.resolve(__dirname, './src/lib/runtime-adapter.ts'),
      '@wails/runtime': path.resolve(__dirname, './src/lib/runtime-adapter.ts'),
      '@wails': path.resolve(__dirname, './bindings'),
    },
  },
  assetsInclude: ['**/*.png', '**/*.jpg', '**/*.jpeg', '**/*.svg'],
})
