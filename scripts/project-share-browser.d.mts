export function projectShareBrowserSource(): {
  name: string
  configResolved(config: { root: string }): void
  resolveId(source: string): string | undefined
  load(this: { addWatchFile(path: string): void }, source: string): Promise<string | undefined>
  handleHotUpdate<T>(context: {
    file: string
    modules: T[]
    server: { moduleGraph: { getModuleById(id: string): T | undefined; invalidateModule(module: T): void } }
  }): T[] | undefined
}
