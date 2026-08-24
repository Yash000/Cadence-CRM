// TypeScript 7's native compiler (this repo pins typescript@^7.0.2 from
// Task 1) does not pick up Next's ambient `declare module '*.css'` the way
// tsc 5 did via next-env.d.ts's triple-slash reference — see TS2882 without
// this file. Declared explicitly so side-effect CSS imports in app/*.tsx
// typecheck without weakening anything else in tsconfig.json.
declare module '*.css';
