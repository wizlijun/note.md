export function computeBucketDir(when: Date): string {
  const y = when.getFullYear();
  const m = (when.getMonth() + 1).toString().padStart(2, "0");
  return `books/${y}/${y}${m}`;
}

export function computeRawPath(bookName: string, ext: string, when: Date): string {
  return `${computeBucketDir(when)}/${bookName}.${ext.toLowerCase()}`;
}
