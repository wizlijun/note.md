declare module 'virtual:share-editor-kit' {
  const manifest: import('./lib/project-share/editor-kit').KitManifest
  export default manifest
  export const assetUrls: Record<string, string>
}
