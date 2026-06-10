import { useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Eye, EyeOff, AlertCircle, UserX, Building2 } from "lucide-react";

type DeactivatedKind = 'account' | 'company' | null;

const DEACTIVATED_COPY: Record<NonNullable<DeactivatedKind>, { icon: React.ReactNode; title: string; body: string }> = {
  account: {
    icon: <UserX className="h-8 w-8 text-red-500" />,
    title: "Account Deactivated",
    body: "Your account has been deactivated. Please contact your company administrator to regain access.",
  },
  company: {
    icon: <Building2 className="h-8 w-8 text-amber-500" />,
    title: "Company Account Disabled",
    body: "Your company's account has been disabled. Please contact your partner admin to restore access.",
  },
};

const Login = () => {
  const { login, companies } = useAuth();
  const navigate = useNavigate();

  const [selectedCompanyId, setSelectedCompanyId] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [deactivated, setDeactivated] = useState<DeactivatedKind>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCompanyId) {
      setError("Please select a company");
      return;
    }
    const selectedCompany = companies.find((c) => c.id === selectedCompanyId);
    if (!selectedCompany) {
      setError("Invalid company selection");
      return;
    }
    setIsLoading(true);
    setError("");
    const result = await login(username, password, selectedCompany.name);
    setIsLoading(false);
    if (result.success) {
      navigate("/");
    } else if (result.error === "account_deactivated") {
      setDeactivated("account");
    } else if (result.error === "company_deactivated") {
      setDeactivated("company");
    } else {
      setError(result.error || "Login failed");
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      {/* Deactivation modal */}
      {deactivated && (() => {
        const copy = DEACTIVATED_COPY[deactivated];
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <div className="bg-card border border-border rounded-2xl shadow-xl p-8 max-w-sm w-full text-center space-y-4">
              <div className="flex justify-center">{copy.icon}</div>
              <h2 className="text-lg font-semibold text-foreground">{copy.title}</h2>
              <p className="text-sm text-muted-foreground">{copy.body}</p>
              <Button
                className="w-full"
                onClick={() => { setDeactivated(null); setPassword(""); }}
              >
                OK
              </Button>
            </div>
          </div>
        );
      })()}
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="flex justify-center mb-8">
          <img src="/riskedge.png" alt="RiskEdge" className="h-16 w-auto object-contain" />
        </div>

        {/* Card */}
        <div className="bg-card border border-border rounded-2xl shadow-sm p-6">
          <h2 className="text-lg font-semibold text-foreground mb-5">Sign in to your account</h2>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="company">Company</Label>
              <Select value={selectedCompanyId} onValueChange={(v) => { setSelectedCompanyId(v); setError(""); }}>
                <SelectTrigger id="company">
                  <SelectValue placeholder="Select a company" />
                </SelectTrigger>
                <SelectContent className="bg-popover border border-border shadow-lg z-50">
                  {companies.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="username">Username</Label>
              <Input
                id="username"
                type="text"
                placeholder="Enter username"
                value={username}
                onChange={(e) => { setUsername(e.target.value); setError(""); }}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  placeholder="Enter password"
                  value={password}
                  onChange={(e) => { setPassword(e.target.value); setError(""); }}
                  required
                  className="pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {error && (
              <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg p-3">
                <AlertCircle className="w-4 h-4 shrink-0" />
                {error}
              </div>
            )}

            <Button type="submit" className="w-full" size="lg" disabled={isLoading}>
              {isLoading ? "Signing in…" : "Sign In"}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
};

export default Login;
