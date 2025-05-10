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
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // This key '@' must exactly match what you use in your imports (e.g., import ... from '@/components')
      // The value must be an absolute path to your 'src' directory (or wherever '@/' should point)
      '@': path.resolve(__dirname, './src'),
      // If shadcn created components in a different subfolder like 'src/components',
      // and you aliased '@/' to 'src/', then imports like '@/components/ui/slider'
      // should correctly resolve to 'src/components/ui/slider'.
    },
  },
})
