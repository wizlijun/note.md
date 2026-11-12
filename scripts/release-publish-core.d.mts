export interface CompanionMetadata {
  schema: 1; product: 'Fcitx5 for Sumi'; version: string; platform: 'darwin-aarch64';
  filename: string; sha256: string; bytes: number; sourceCommit: string;
  appNotarized: true; packageSigned: boolean;
}
export function validateCompanionMetadata(value: unknown): CompanionMetadata
export interface ReleaseAsset { name: string; url: string; content?: string; sha256?: string; bytes?: number }
export function validateRelease(input: {
  tag: string; draft: boolean; assets: ReleaseAsset[];
  latest?: { version: string; platforms: Record<string, { url: string; signature: string }> };
  approvedCompanion?: unknown;
  without?: string;
  macArm64Only?: boolean;
  linuxOnly?: boolean;
  linuxAmd64Only?: boolean;
}): { version: string }
