// guacamole-common-js ships no type declarations. The RDP v2 client uses it through a
// dynamic import and treats the namespace as `any`; this shim satisfies the compiler.
declare module 'guacamole-common-js';
