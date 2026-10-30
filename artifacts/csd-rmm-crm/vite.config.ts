import path from 'path';
import react from '@vitejs/plugin-react';
import autoprefixer from 'autoprefixer';
import tailwindcss from 'tailwindcss';
import { defineConfig } from 'vite';

import runtimeErrorOverlay from '@replit/vite-plugin-runtime-error-modal';

// PORT only configures the dev and preview servers, so it is resolved per
// command below. Requiring it unconditionally made `vite build` — and with it
// the workspace's `pnpm run build` — fail outside a running Replit workflow.
function resolveDevPort(): number {
  const rawPort = process.env.PORT;

  if (!rawPort) {
    throw new Error(
      'PORT environment variable is required but was not provided.',
    );
  }

  const port = Number(rawPort);

  if (Number.isNaN(port) || port <= 0) {
    throw new Error(`Invalid PORT value: "${rawPort}"`);
  }

  return port;
}

// BASE_PATH stays required for every command: it is baked into the emitted
// asset URLs, so guessing it would silently ship a broken bundle.
const basePath = process.env.BASE_PATH;

if (!basePath) {
  throw new Error(
    'BASE_PATH environment variable is required but was not provided.',
  );
}

export default defineConfig(async ({ command }) => {
  // `vite build` never binds a port; only `serve` (dev) and `preview` do.
  const port = command === 'serve' ? resolveDevPort() : undefined;

  return {
    base: basePath,
    plugins: [
      react(),
      runtimeErrorOverlay({
        // Cross-origin SDK scripts can emit opaque browser events whose
        // `error` value is null. The plugin turns those into a fabricated
        // "(unknown runtime error)" overlay with no actionable stack.
        // Preserve the overlay for every real runtime error.
        filter: (error) => error.message !== '(unknown runtime error)',
      }),
      ...(process.env.NODE_ENV !== 'production' &&
      process.env.REPL_ID !== undefined
        ? [
            await import('@replit/vite-plugin-cartographer').then((m) =>
              m.cartographer({
                root: path.resolve(import.meta.dirname, '..'),
              }),
            ),
            await import('@replit/vite-plugin-dev-banner').then((m) =>
              m.devBanner(),
            ),
          ]
        : []),
    ],
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, 'src'),
        '@shared': path.resolve(import.meta.dirname, 'src', 'shared'),
        '@assets': path.resolve(
          import.meta.dirname,
          '..',
          '..',
          'attached_assets',
        ),
      },
      dedupe: ['react', 'react-dom'],
    },
    root: path.resolve(import.meta.dirname),
    css: {
      postcss: {
        plugins: [tailwindcss(), autoprefixer()],
      },
    },
    build: {
      outDir: path.resolve(import.meta.dirname, 'dist/public'),
      emptyOutDir: true,
    },
    server: {
      port,
      strictPort: true,
      host: '0.0.0.0',
      allowedHosts: true,
      fs: {
        strict: false,
      },
    },
    preview: {
      port,
      host: '0.0.0.0',
      allowedHosts: true,
    },
  };
});
