/// <reference types="vite/client" />
/// <reference types="vite-plugin-pages/client-react" />

declare module "*?url" {
  const src: string
  export default src
}

declare module "*.module.less" {
  const classes: Record<string, string>
  export default classes
}

declare module "*.less" {
  const css: string
  export default css
}

declare module "dsh-providers-hub/provider-registry" {
  export const PROVIDER_REGISTRY: Array<{ id: string; label?: string; displayName?: string }>
}
