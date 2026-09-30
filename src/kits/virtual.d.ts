// The kit bundles the dev server builds (vite.config.ts `kitModules`, docs/KITS.md).
declare module 'virtual:karyo-kits' {
  const bundle: import('./types').KitBundle;
  export default bundle;
}
declare module 'virtual:karyo-kits/*' {
  const bundle: import('./types').KitBundle;
  export default bundle;
}
