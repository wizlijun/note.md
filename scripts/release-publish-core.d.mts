export interface ReleaseAsset { name: string; url: string; content?: string; sha256?: string }
export function validateRelease(input: {
  tag: string; draft: boolean; assets: ReleaseAsset[];
  latest: { version: string; platforms: Record<string, { url: string; signature: string }> };
  without?: string;
  macArm64Only?: boolean;
}): { version: string }
