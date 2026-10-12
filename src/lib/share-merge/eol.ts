export function alignEol(base: string, theirs: string): { theirs: string; aligned: boolean } {
  let result = theirs
  if (base.includes('\r\n') && !result.includes('\r')) result = result.replace(/\n/g, '\r\n')
  if (base.startsWith('\uFEFF') && !result.startsWith('\uFEFF')) result = '\uFEFF' + result
  return { theirs: result, aligned: result !== theirs }
}
