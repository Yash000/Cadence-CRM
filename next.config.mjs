// Plain JS rather than next.config.ts: kept as-is from Task 5. The original
// reason (Next's TS config loader crashing against typescript@^7.0.2) went
// away when Task 6 pinned TypeScript to 5.9, but a .mjs config is valid and
// there is no reason to churn it back.
//
// The `experimental.extensionAlias` shim Task 5 needed (webpack resolving
// db/index.ts's './schema.js' specifier) is gone: db/index.ts now imports
// './schema' extensionless, which Turbopack, tsc and tsx all resolve.
// `agentRules: false` is likewise gone — it is a Next 16 key and Next 15
// rejects it as unrecognized.
/** @type {import('next').NextConfig} */
const nextConfig = {};

export default nextConfig;
