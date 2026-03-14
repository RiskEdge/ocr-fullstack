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
  login: (username: string, password: string, companyName: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => void;
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

  useEffect(() => {
    const savedToken = localStorage.getItem(TOKEN_KEY);
    const savedUser = localStorage.getItem(USER_KEY);
    if (savedToken && savedUser) {
      try {
        setToken(savedToken);
        setUser(JSON.parse(savedUser));
      } catch {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USER_KEY);
      }
    }
    setIsLoading(false);
  }, []);

  const login = useCallback(async (username: string, password: string, companyName: string) => {
    try {
      const { data } = await api.post('/v1/login', { company_name: companyName, username, password });
      const newUser: User = { username, company: companyName };
      localStorage.setItem(TOKEN_KEY, data.access_token);
      localStorage.setItem(USER_KEY, JSON.stringify(newUser));
      setToken(data.access_token);
      setUser(newUser);
      return { success: true };
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      return { success: false, error: detail || 'Network error — is the backend running?' };
    }
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    setToken(null);
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        isAuthenticated: !!user,
        isLoading,
        login,
        logout,
        companies: dummyCompanies,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};
