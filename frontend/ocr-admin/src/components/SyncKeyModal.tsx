import { useState } from 'react'
import { Copy, Check, Key, AlertTriangle } from 'lucide-react'

interface Props {
  secret: string
  clientCode: string | null
  onDismiss: () => void
}

export default function SyncKeyModal({ secret, clientCode, onDismiss }: Props) {
  const [copied, setCopied]       = useState(false)
  const [confirmed, setConfirmed] = useState(false)

  function copy() {
    navigator.clipboard.writeText(secret).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2500)
    })
  }

  return (
    <>
      {/* Sits above CompanySyncPanel (z-50) */}
      <div className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm" />
      <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
        <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg">

          {/* Header */}
          <div className="flex items-center gap-3 px-6 py-5 border-b border-gray-100">
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-indigo-50">
              <Key className="h-5 w-5 text-indigo-600" />
            </div>
            <div>
              <h2 className="text-base font-bold text-gray-900">Sync Secret Generated</h2>
              <p className="text-xs text-gray-400 mt-0.5">Store this secret now — it will not be shown again</p>
            </div>
          </div>

          <div className="px-6 py-5 space-y-4">

            {/* Warning banner */}
            <div className="flex items-start gap-2.5 p-3 bg-amber-50 border border-amber-100 rounded-lg">
              <AlertTriangle className="h-4 w-4 text-amber-600 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-amber-700 leading-relaxed">
                This is the only time this secret will be visible. Copy it and store it in your ERP configuration immediately. Closing without copying means you must generate a new key.
              </p>
            </div>

            {/* Secret display + copy */}
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1.5">Bearer Token</label>
              <div className="flex items-center gap-2 p-3 bg-gray-50 rounded-lg border border-gray-200">
                <code className="flex-1 text-xs font-mono text-gray-800 break-all select-all">{secret}</code>
                <button
                  onClick={copy}
                  className={`flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                    copied
                      ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                      : 'bg-white border border-gray-200 text-gray-600 hover:border-indigo-300 hover:text-indigo-600'
                  }`}
                >
                  {copied
                    ? <><Check className="h-3.5 w-3.5" /> Copied</>
                    : <><Copy className="h-3.5 w-3.5" /> Copy</>
                  }
                </button>
              </div>
            </div>

            {/* Usage example */}
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1.5">ERP Sync Request Format</label>
              <div className="p-3 bg-gray-900 rounded-lg text-xs font-mono space-y-0.5">
                <p className="text-gray-400">POST /v1/sync/master-data</p>
                <p className="text-indigo-300">
                  Authorization: Bearer{' '}
                  <span className="text-gray-500">&lt;secret above&gt;</span>
                </p>
                <p className="text-gray-600 mt-2">{'{'}</p>
                {clientCode && (
                  <p className="text-green-400 pl-4">
                    "client_code": "<span className="text-yellow-300">{clientCode}</span>",
                  </p>
                )}
                <p className="text-green-400 pl-4">"mode": "upsert",</p>
                <p className="text-green-400 pl-4">"products": [...]</p>
                <p className="text-gray-600">{'}'}</p>
              </div>
            </div>

            {/* Confirmation checkbox */}
            <label className="flex items-center gap-2.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={e => setConfirmed(e.target.checked)}
                className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
              />
              <span className="text-sm text-gray-700">
                I have copied and securely stored the secret
              </span>
            </label>
          </div>

          {/* Footer */}
          <div className="px-6 pb-5">
            <button
              onClick={onDismiss}
              disabled={!confirmed}
              className="w-full py-2.5 px-4 rounded-lg text-sm font-semibold bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Close — I've saved the secret
            </button>
          </div>

        </div>
      </div>
    </>
  )
}
