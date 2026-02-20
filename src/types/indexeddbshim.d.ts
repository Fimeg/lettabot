declare module 'indexeddbshim/src/node.js' {
  function setGlobalVars(idbFactory: null, opts?: Record<string, unknown>): void;
  export = setGlobalVars;
}
