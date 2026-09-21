// Set by esbuild at build time (see build.ts).
declare const __LA_COOP_VERSION__: string;

// Stylesheets are bundled as text and injected where they are needed.
declare module '*.css' {
  const css: string;
  export default css;
}
