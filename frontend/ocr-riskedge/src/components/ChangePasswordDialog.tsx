import { useState } from "react";
import { KeyRound, X, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import api from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function ChangePasswordDialog({ open, onClose }: Props) {
  const { token } = useAuth();
  const [current,  setCurrent]  = useState("");
  const [next,     setNext]     = useState("");
  const [confirm,  setConfirm]  = useState("");
  const [showCur,  setShowCur]  = useState(false);
  const [showNew,  setShowNew]  = useState(false);
  const [saving,   setSaving]   = useState(false);
  const [error,    setError]    = useState("");
  const [success,  setSuccess]  = useState(false);

  if (!open) return null;

  function reset() {
    setCurrent(""); setNext(""); setConfirm("");
    setError(""); setSuccess(false); setSaving(false);
    setShowCur(false); setShowNew(false);
  }

  function close() { reset(); onClose(); }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (next.length < 8) { setError("New password must be at least 8 characters."); return; }
    if (next !== confirm) { setError("Passwords do not match."); return; }

    setSaving(true);
    try {
      await api.patch("/v1/user/change-password", {
        current_password: current,
        new_password: next,
      }, { headers: { Authorization: `Bearer ${token}` } });
      setSuccess(true);
      setTimeout(close, 1500);
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(detail ?? "Failed to update password.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={close} />
      <div className="relative z-10 w-full max-w-sm mx-4 bg-card rounded-xl border border-border shadow-xl p-6">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2">
            <KeyRound className="w-4 h-4 text-primary" />
            <h2 className="text-sm font-semibold text-foreground">Change Password</h2>
          </div>
          <button onClick={close} className="text-muted-foreground hover:text-foreground transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {success ? (
          <p className="text-sm text-green-600 text-center py-4">Password updated successfully.</p>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="cp-current" className="text-xs">Current password</Label>
              <div className="relative">
                <Input
                  id="cp-current"
                  type={showCur ? "text" : "password"}
                  value={current}
                  onChange={e => setCurrent(e.target.value)}
                  required
                  autoComplete="current-password"
                  className="pr-9 text-sm"
                />
                <button
                  type="button"
                  onClick={() => setShowCur(v => !v)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  tabIndex={-1}
                >
                  {showCur ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="cp-new" className="text-xs">New password</Label>
              <div className="relative">
                <Input
                  id="cp-new"
                  type={showNew ? "text" : "password"}
                  value={next}
                  onChange={e => setNext(e.target.value)}
                  required
                  autoComplete="new-password"
                  className="pr-9 text-sm"
                />
                <button
                  type="button"
                  onClick={() => setShowNew(v => !v)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  tabIndex={-1}
                >
                  {showNew ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </div>
              <p className="text-xs text-muted-foreground">Minimum 8 characters.</p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="cp-confirm" className="text-xs">Confirm new password</Label>
              <Input
                id="cp-confirm"
                type="password"
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                required
                autoComplete="new-password"
                className="text-sm"
              />
            </div>

            {error && <p className="text-xs text-destructive">{error}</p>}

            <div className="flex gap-2 pt-1">
              <Button type="submit" disabled={saving || !current || !next || !confirm} className="flex-1 text-sm">
                {saving ? "Updating…" : "Update password"}
              </Button>
              <Button type="button" variant="outline" onClick={close} className="text-sm">
                Cancel
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
