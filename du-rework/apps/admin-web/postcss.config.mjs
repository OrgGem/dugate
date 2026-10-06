/**
 * Intentionally EMPTY PostCSS pipeline.
 *
 * Tailwind CSS v4 is handled by `@tailwindcss/vite` (see vite.config.ts).
 * Without this file, Vite walks up the directory tree and picks up the legacy
 * Next.js app's PostCSS config (`D:/Git/dugate/postcss.config.mjs`, Tailwind
 * v3), which cannot process Tailwind v4 CSS. An explicit (empty) config stops
 * that inheritance.
 */
export default {
  plugins: {},
};
