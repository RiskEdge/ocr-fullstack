import { useState, useEffect } from 'react'
import {
  X, Key, Trash2, RefreshCw,
  AlertTriangle, Database, Clock, Check, Pencil,
} from 'lucide-react'
import { api } from '@/lib/api'
import { useTheme } from '@/contexts/ThemeContext'
import SyncKeyModal from './SyncKeyModal'
import type { Company, SyncStatus } from '@/types'

interface Props {
  company: Company
  onClose: () => void
  onRefresh: () => void
}

export default function CompanySyncPanel({ company, onClose, onRefresh }: Props) {
  const theme = useTheme()
  const inputCls = `w-full px-3 py-2 rounded-lg border border-gray-200 text-sm bg-white focus:outline-none focus:ring-2 ${theme.focusRing} focus:border-transparent transition-colors`

  // Sync status (fetched on open)
  const [syncStatus,    setSyncStatus]    = useState<SyncStatus | null>(null)
  const [statusLoading, setStatusLoading] = useState(true)
  const [statusError,   setStatusError]   = useState('')

  // Client code editing
  const [codeEditing, setCodeEditing] = useState(false)
  const [codeVal,     setCodeVal]     = useState(company.client_code ?? '')
  const [codeSaving,  setCodeSaving]  = useState(false)
  const [codeError,   setCodeError]   = useState('')

  // Sync key operations
  const [generating,    setGenerating]    = useState(false)
  const [revokeConfirm, setRevokeConfirm] = useState(false)
  const [revoking,      setRevoking]      = useState(false)
  const [keyError,      setKeyError]      = useState('')
  const [generatedKey,  setGeneratedKey]  = useState<string | null>(null)

  // Derived sync-enabled: use live status if loaded, else fall back to list-page value
  const syncEnabled = syncStatus ? syncStatus.sync_enabled : company.sync_enabled

  function loadStatus() {
    setStatusLoading(true)
    setStatusError('')
    api.syncStatus(company.id)
      .then(s => setSyncStatus(s))
      .catch(e => setStatusError(e.message))
      .finally(() => setStatusLoading(false))
  }

  useEffect(loadStatus, [company.id])

  // Close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape' && !generatedKey) onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, generatedKey])

  async function saveClientCode() {
    if (!codeVal.trim()) return
    setCodeSaving(true)
    setCodeError('')
    try {
      await api.updateClientCode(company.id, codeVal.trim())
      setCodeEditing(false)
      onRefresh()
    } catch (e) {
      setCodeError(e instanceof Error ? e.message : 'Failed to update client code.')
    } finally {
      setCodeSaving(false)
    }
  }

  async function generateKey() {
    setGenerating(true)
    setKeyError('')
    try {
      const result = await api.generateSyncKey(company.id)
      setGeneratedKey(result.sync_secret)
      loadStatus()
      onRefresh()
    } catch (e) {
      setKeyError(e instanceof Error ? e.message : 'Failed to generate sync key.')
    } finally {
      setGenerating(false)
    }
  }

  async function revokeKey() {
    setRevoking(true)
    setKeyError('')
    try {
      await api.revokeSyncKey(company.id)
      setRevokeConfirm(false)
      loadStatus()
      onRefresh()
    } catch (e) {
      setKeyError(e instanceof Error ? e.message : 'Failed to revoke sync key.')
    } finally {
      setRevoking(false)
    }
  }

  function fmtDate(iso: string) {
    return new Date(iso).toLocaleString('en-IN', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true,
    })
  }

  function fmtDateShort(iso: string) {
    return new Date(iso).toLocaleDateString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric',
    })
  }

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">

          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 flex-shrink-0">
            <div>
              <h2 className="text-base font-bold text-gray-900">{company.name}</h2>
              <p className="text-xs text-gray-400 mt-0.5">ERP integration & sync settings</p>
            </div>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-700 transition-colors"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Scrollable body */}
          <div className="overflow-y-auto flex-1 px-6 py-5 space-y-6">

            {/* Stats row */}
            <div className="grid grid-cols-3 gap-3">
              <div className="bg-gray-50 rounded-lg p-3.5">
                <p className="text-xs text-gray-400 mb-1">Sync Status</p>
                {syncEnabled ? (
                  <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-emerald-700">
                    <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                    Active
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-gray-400">
                    <span className="h-2 w-2 rounded-full bg-gray-300" />
                    Disabled
                  </span>
                )}
              </div>
              <div className="bg-gray-50 rounded-lg p-3.5">
                <p className="flex items-center gap-1 text-xs text-gray-400 mb-1">
                  <Database className="h-3 w-3" /> Catalog Items
                </p>
                <p className="text-sm font-semibold text-gray-800">
                  {company.catalog_item_count?.toLocaleString() ?? '—'}
                </p>
              </div>
              <div className="bg-gray-50 rounded-lg p-3.5">
                <p className="flex items-center gap-1 text-xs text-gray-400 mb-1">
                  <Clock className="h-3 w-3" /> Last Synced
                </p>
                {syncStatus?.last_synced_at ? (
                  <>
                    <p className="text-sm font-semibold text-gray-800">
                      {fmtDateShort(syncStatus.last_synced_at)}
                    </p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {new Date(syncStatus.last_synced_at).toLocaleTimeString('en-IN', {
                        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
                      })}
                    </p>
                  </>
                ) : (
                  <p className="text-sm text-gray-300 font-normal">Never</p>
                )}
              </div>
            </div>

            {/* ── Client Code ─────────────────────────────────────────── */}
            <section>
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
                ERP Client Code
              </h3>
              <div className="bg-gray-50 rounded-lg p-4">
                <p className="text-xs text-gray-500 mb-3 leading-relaxed">
                  The short identifier your ERP sends in the{' '}
                  <code className="bg-gray-200 px-1 rounded text-gray-700 text-[11px]">client_code</code>{' '}
                  field of every sync request.
                </p>

                {codeEditing ? (
                  <div className="space-y-2">
                    <div className="flex gap-2">
                      <input
                        value={codeVal}
                        onChange={e => setCodeVal(e.target.value.toUpperCase())}
                        placeholder="e.g. STR001"
                        maxLength={50}
                        autoFocus
                        className={`${inputCls} font-mono`}
                      />
                      <button
                        onClick={saveClientCode}
                        disabled={codeSaving || !codeVal.trim()}
                        className={`px-4 py-2 rounded-lg text-sm font-semibold whitespace-nowrap disabled:opacity-50 transition-colors ${theme.primaryBtn}`}
                      >
                        {codeSaving ? 'Saving…' : 'Save'}
                      </button>
                      <button
                        onClick={() => { setCodeEditing(false); setCodeVal(company.client_code ?? '') }}
                        className="px-4 py-2 rounded-lg border border-gray-200 text-sm text-gray-600 hover:bg-white transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                    {codeError && <p className="text-xs text-red-500">{codeError}</p>}
                  </div>
                ) : (
                  <div className="flex items-center justify-between">
                    {company.client_code ? (
                      <code className="text-sm font-mono text-gray-800 bg-white border border-gray-200 px-3 py-1.5 rounded-lg">
                        {company.client_code}
                      </code>
                    ) : (
                      <span className="text-sm text-gray-400">Not configured</span>
                    )}
                    <button
                      onClick={() => setCodeEditing(true)}
                      className={`flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border border-gray-200 transition-colors hover:bg-white ${theme.hoverAccentText}`}
                    >
                      <Pencil className="h-3 w-3" />
                      {company.client_code ? 'Change' : 'Set Code'}
                    </button>
                  </div>
                )}
              </div>
            </section>

            {/* ── Sync Key ─────────────────────────────────────────────── */}
            <section>
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
                Sync API Key
              </h3>
              <div className="bg-gray-50 rounded-lg p-4 space-y-4">
                <p className="text-xs text-gray-500 leading-relaxed">
                  {syncEnabled
                    ? 'A key is active. The ERP system can push catalog data to this company.'
                    : 'No key is set. Generate one to enable ERP sync for this company.'
                  }
                </p>

                {keyError && (
                  <div className="flex items-center gap-2 p-2.5 bg-red-50 rounded-lg text-xs text-red-600 border border-red-100">
                    <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
                    {keyError}
                  </div>
                )}

                {revokeConfirm ? (
                  <div className="flex items-start gap-3 p-3 bg-red-50 border border-red-100 rounded-lg">
                    <AlertTriangle className="h-4 w-4 text-red-500 flex-shrink-0 mt-0.5" />
                    <div className="flex-1">
                      <p className="text-xs text-red-700 leading-relaxed mb-3">
                        Revoking the key immediately blocks all incoming sync calls. The ERP will need a newly generated key to resume syncing.
                      </p>
                      <div className="flex gap-2">
                        <button
                          onClick={revokeKey}
                          disabled={revoking}
                          className="px-4 py-1.5 rounded-lg text-xs font-semibold bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 transition-colors"
                        >
                          {revoking ? 'Revoking…' : 'Yes, revoke key'}
                        </button>
                        <button
                          onClick={() => setRevokeConfirm(false)}
                          className="px-4 py-1.5 rounded-lg text-xs font-semibold border border-red-200 text-red-600 hover:bg-white transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={generateKey}
                      disabled={generating}
                      className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold disabled:opacity-50 transition-colors ${theme.primaryBtn}`}
                    >
                      <Key className="h-4 w-4" />
                      {generating ? 'Generating…' : syncEnabled ? 'Regenerate Key' : 'Generate Key'}
                    </button>
                    {syncEnabled && (
                      <button
                        onClick={() => setRevokeConfirm(true)}
                        className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold border border-red-200 text-red-600 hover:bg-red-50 transition-colors"
                      >
                        <Trash2 className="h-4 w-4" />
                        Revoke Key
                      </button>
                    )}
                  </div>
                )}

                <p className="text-xs text-gray-400">
                  The secret is transmitted as{' '}
                  <code className="bg-gray-200 text-gray-600 px-1 rounded text-[11px]">
                    Authorization: Bearer &lt;secret&gt;
                  </code>
                  {' '}on every sync request.
                </p>
              </div>
            </section>

            {/* ── Sync History ─────────────────────────────────────────── */}
            <section>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                  Recent Sync History
                </h3>
                <button
                  onClick={loadStatus}
                  disabled={statusLoading}
                  className="text-gray-400 hover:text-gray-700 transition-colors disabled:opacity-50"
                  title="Refresh"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${statusLoading ? 'animate-spin' : ''}`} />
                </button>
              </div>

              {statusError && (
                <p className="text-sm text-red-500 mb-2">{statusError}</p>
              )}

              {statusLoading ? (
                <div className="flex justify-center py-8">
                  <div className={`h-5 w-5 rounded-full border-2 border-t-transparent animate-spin ${theme.spinner}`} />
                </div>
              ) : !syncStatus?.recent_syncs?.length ? (
                <div className="rounded-lg border border-gray-100 py-10 text-center text-sm text-gray-400">
                  No sync history yet.
                </div>
              ) : (
                <div className="rounded-lg border border-gray-100 overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className={`text-xs font-semibold text-white ${theme.tableHeaderGradient}`}>
                        <th className="px-4 py-2.5 text-left">Date & Time</th>
                        <th className="px-4 py-2.5 text-left">Mode</th>
                        <th className="px-4 py-2.5 text-right">Synced</th>
                        <th className="px-4 py-2.5 text-right">Skipped</th>
                        <th className="px-4 py-2.5 text-left">Result</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {syncStatus.recent_syncs.map((log, i) => (
                        <tr
                          key={log.id}
                          className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50/50'}
                        >
                          <td className="px-4 py-2.5 text-gray-600 whitespace-nowrap text-xs">
                            {fmtDate(log.triggered_at)}
                          </td>
                          <td className="px-4 py-2.5">
                            <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${
                              log.mode === 'replace'
                                ? 'bg-amber-50 text-amber-700'
                                : 'bg-blue-50 text-blue-700'
                            }`}>
                              {log.mode}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-right text-gray-700 font-medium text-xs">
                            {log.records_synced.toLocaleString()}
                          </td>
                          <td className="px-4 py-2.5 text-right text-xs">
                            {log.records_skipped > 0
                              ? <span className="text-amber-600 font-medium">{log.records_skipped}</span>
                              : <span className="text-gray-400">0</span>
                            }
                          </td>
                          <td className="px-4 py-2.5">
                            {log.status === 'success' ? (
                              <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600">
                                <Check className="h-3 w-3" /> success
                              </span>
                            ) : (
                              <span
                                className="inline-flex items-center gap-1 text-xs font-medium text-red-500 cursor-help"
                                title={log.error_message ?? 'Unknown error'}
                              >
                                <AlertTriangle className="h-3 w-3" /> error
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

          </div>{/* /scrollable body */}
        </div>
      </div>

      {/* One-time key display — shown on top when a key is generated */}
      {generatedKey && (
        <SyncKeyModal
          secret={generatedKey}
          clientCode={company.client_code}
          onDismiss={() => setGeneratedKey(null)}
        />
      )}
    </>
  )
}
