// Plain JS, not next.config.ts: Next's TS config loader crashes
// (`Cannot read properties of undefined (reading 'fileExists')`) against
// this repo's typescript@^7.0.2 (Task 1's pin — the native/preview
// compiler). App code still typechecks fine under TS7 (see global.d.ts and
// `npx tsc --noEmit`); it's specifically Next's config-loading shim that
// doesn't yet support TS7's Program/LanguageService shape. A .mjs config
// sidesteps that loader entirely.
/** @type {import('next').NextConfig} */
const nextConfig = {
  // Don't let `next dev`/`next build` write CLAUDE.md/AGENTS.md into the
  // repo root — unrelated to this task and not something we want committed.
  agentRules: false,
  // db/index.ts (Task 1, not owned by this task) imports './schema.js' —
  // the TS "moduleResolution: bundler" convention of writing the .js
  // specifier for a .ts file. webpack doesn't resolve that by default;
  // this tells it to also try .ts/.tsx when a .js specifier 404s.
  experimental: {
    extensionAlias: {
      '.js': ['.ts', '.tsx', '.js'],
    },
  },
};

export default nextConfig;
