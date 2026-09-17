// Number and text formatting shared by budget labels and injected reminders.

export function note(lines: string[]): string {
  return `\n\n<system-reminder>\n${lines.join("\n")}\n</system-reminder>`
}

export function fmtCount(n: number): string {
  return `${Math.round(n)}`
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return `${Math.round(n)}`
}

export function fmtBytes(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}MB`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}kB`
  return `${Math.round(n)}B`
}

export function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`
}
