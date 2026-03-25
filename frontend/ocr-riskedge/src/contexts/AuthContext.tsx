import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from "react";
import { Company, dummyCompanies } from "@/data/dummyCredentials";
import api from "@/lib/api";

const TOKEN_KEY = 'ocr_access_token';
const USER_KEY = 'ocr_user';

interface User {
  username: string;
  company: string;
}

interface AuthContextType {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  credits: number | null;
  login: (username: string, password: string, companyName: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => void;
  refreshCredits: () => Promise<void>;
  setCredits: (value: number) => void;
  companies: Company[];
}

const AuthContext = createContext<AuthContextType | null>(null);

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
};

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [credits, setCredits] = useState<number | null>(null);

  const fetchCredits = useCallback(async (authToken: string) => {
    try {
      const { data } = await api.get('/v1/credits', {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      setCredits(data.credits);
    } catch {
      // silently ignore — credits will show as null
    }
  }, []);

  useEffect(() => {
    const savedToken = localStorage.getItem(TOKEN_KEY);
    const savedUser = localStorage.getItem(USER_KEY);
    if (savedToken && savedUser) {
      try {
        setToken(savedToken);
        setUser(JSON.parse(savedUser));
        fetchCredits(savedToken);
      } catch {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USER_KEY);
      }
    }
    setIsLoading(false);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const login = useCallback(async (username: string, password: string, companyName: string) => {
    try {
      const { data } = await api.post('/v1/login', { company_name: companyName, username, password });
      const newUser: User = { username, company: companyName };
      localStorage.setItem(TOKEN_KEY, data.access_token);
      localStorage.setItem(USER_KEY, JSON.stringify(newUser));
      setToken(data.access_token);
      setUser(newUser);
      await fetchCredits(data.access_token);
      return { success: true };
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      return { success: false, error: detail || 'Network error — is the backend running?' };
    }
  }, [fetchCredits]);

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    setToken(null);
    setUser(null);
    setCredits(null);
  }, []);

  const refreshCredits = useCallback(async () => {
    const t = localStorage.getItem(TOKEN_KEY);
    if (t) await fetchCredits(t);
  }, [fetchCredits]);

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        isAuthenticated: !!user,
        isLoading,
        credits,
        login,
        logout,
        refreshCredits,
        setCredits,
        companies: dummyCompanies,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};
