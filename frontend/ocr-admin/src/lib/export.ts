import writeXlsxFile from 'write-excel-file'

export interface ExportColumn {
  key: string
  header: string
}

function getVal(row: Record<string, unknown>, key: string): unknown {
  // Supports dot-notation keys like "last_30d.ocr_runs"
  return key.split('.').reduce<unknown>((obj, k) => {
    if (obj && typeof obj === 'object') return (obj as Record<string, unknown>)[k]
    return undefined
  }, row)
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function exportToCsv(
  filename: string,
  columns: ExportColumn[],
  data: Record<string, unknown>[],
): void {
  const header = columns.map(c => c.header).join(',')
  const rows = data.map(row =>
    columns
      .map(c => {
        const val = String(getVal(row, c.key) ?? '')
        return val.includes(',') || val.includes('"') || val.includes('\n')
          ? `"${val.replace(/"/g, '""')}"`
          : val
      })
      .join(','),
  )
  const csv = [header, ...rows].join('\n')
  triggerDownload(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), `${filename}.csv`)
}

export async function exportToExcel(
  filename: string,
  columns: ExportColumn[],
  data: Record<string, unknown>[],
): Promise<void> {
  const header = columns.map(c => ({ value: c.header, fontWeight: 'bold' as const }))
  const rows = data.map(row =>
    columns.map(c => {
      const v = getVal(row, c.key)
      if (v == null) return { value: null }
      if (typeof v === 'number') return { value: v }
      return { value: String(v) }
    }),
  )
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (writeXlsxFile as (data: any, opts: any) => Promise<void>)([header, ...rows], { fileName: `${filename}.xlsx` })
}
