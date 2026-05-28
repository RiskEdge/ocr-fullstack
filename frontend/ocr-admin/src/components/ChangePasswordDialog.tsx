import { useState } from 'react'
import { X, Eye, EyeOff } from 'lucide-react'
import { api } from '@/lib/api'
import { useTheme } from '@/contexts/ThemeContext'

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function ChangePasswordDialog({ open, onClose }: Props) {
  const theme = useTheme()
  const inputCls = `w-full px-3 py-2 rounded-lg border border-gray-200 text-sm bg-white focus:outline-none focus:ring-2 ${theme.focusRing} focus:border-transparent transition-colors pr-9`

  const [current,  setCurrent]  = useState('')
  const [next,     setNext]     = useState('')
  const [confirm,  setConfirm]  = useState('')
  const [showCur,  setShowCur]  = useState(false)
  const [showNew,  setShowNew]  = useState(false)
  const [saving,   setSaving]   = useState(false)
  const [error,    setError]    = useState('')
  const [success,  setSuccess]  = useState(false)

  if (!open) return null

  function reset() {
    setCurrent(''); setNext(''); setConfirm('')
    setError(''); setSuccess(false); setSaving(false)
    setShowCur(false); setShowNew(false)
  }

  function close() { reset(); onClose() }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (next.length < 8) { setError('New password must be at least 8 characters.'); return }
    if (next !== confirm) { setError('Passwords do not match.'); return }

    setSaving(true)
    try {
      await api.changePassword(current, next)
      setSuccess(true)
      setTimeout(close, 1500)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update password.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={close} />
      <div className="relative z-10 w-full max-w-sm mx-4 bg-white rounded-xl border border-gray-200 shadow-xl p-6">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-sm font-semibold text-gray-900">Change Password</h2>
          <button onClick={close} className="text-gray-400 hover:text-gray-600 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {success ? (
          <p className="text-sm text-green-600 text-center py-4">Password updated successfully.</p>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Current password</label>
              <div className="relative">
                <input
                  type={showCur ? 'text' : 'password'}
                  value={current}
                  onChange={e => setCurrent(e.target.value)}
                  required
                  autoComplete="current-password"
                  className={inputCls}
                />
                <button
                  type="button"
                  onClick={() => setShowCur(v => !v)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  tabIndex={-1}
                >
                  {showCur ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>

            <div>
              <label className="block text-xs text-gray-500 mb-1">New password</label>
              <div className="relative">
                <input
                  type={showNew ? 'text' : 'password'}
                  value={next}
                  onChange={e => setNext(e.target.value)}
                  required
                  autoComplete="new-password"
                  className={inputCls}
                />
                <button
                  type="button"
                  onClick={() => setShowNew(v => !v)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  tabIndex={-1}
                >
                  {showNew ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </div>
              <p className="text-xs text-gray-400 mt-1">Minimum 8 characters.</p>
            </div>

            <div>
              <label className="block text-xs text-gray-500 mb-1">Confirm new password</label>
              <input
                type="password"
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                required
                autoComplete="new-password"
                className={inputCls.replace('pr-9', '')}
              />
            </div>

            {error && <p className="text-xs text-red-500">{error}</p>}

            <div className="flex gap-2 pt-1">
              <button
                type="submit"
                disabled={saving || !current || !next || !confirm}
                className={`flex-1 px-4 py-2 rounded-lg text-sm font-semibold disabled:opacity-50 transition-colors ${theme.primaryBtn}`}
              >
                {saving ? 'Updating…' : 'Update password'}
              </button>
              <button
                type="button"
                onClick={close}
                className="px-4 py-2 rounded-lg border border-gray-200 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
