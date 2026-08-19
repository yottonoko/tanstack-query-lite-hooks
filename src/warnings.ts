/** 開発時の警告を一度だけ出すための内部ヘルパー */

const warnedFields = new Set<string>()

const isDevelopment =
  typeof process !== 'undefined' && process.env.NODE_ENV !== 'production'

export function warnOnce(field: string, message: string): void {
  if (!isDevelopment || warnedFields.has(field)) {
    return
  }

  warnedFields.add(field)
  console.warn(message)
}

export function warnUnsupportedOption(field: string, detail?: string): void {
  warnOnce(
    `option:${field}`,
    detail ??
      `[tanstack-query-lite-hooks] The query option "${field}" is not supported by the lite runtime and will be ignored.`,
  )
}

export function warnUnsupportedResultProperty(field: string): void {
  warnOnce(
    `result:${field}`,
    `[tanstack-query-lite-hooks] The result property "${field}" is not supported by the lite runtime.`,
  )
}

export function resetWarningsForTests(): void {
  if (isDevelopment) {
    warnedFields.clear()
  }
}
