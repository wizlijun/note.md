export function checkClean(root: string, allowPath?: string, versionChanges?: boolean): { preserved: string[]; status: string }
export function checkFrozenShare(candidate: string, directory: string): { manifestSha256: string; resources: string[] }
