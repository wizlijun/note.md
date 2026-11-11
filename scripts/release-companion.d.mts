export function stageCompanion(input: {
  approved: unknown;
  source: string;
  output: string;
}): { packagePath: string; metadataPath: string; sha256: string }
