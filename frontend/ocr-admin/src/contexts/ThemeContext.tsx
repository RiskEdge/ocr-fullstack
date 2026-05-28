import { createContext, useContext } from 'react';
import { getRoleTheme, DEFAULT_ROLE_THEME, type RoleTheme } from '@/lib/roleThemes';
import { getUserInfo } from '@/lib/api';

const ThemeContext = createContext<RoleTheme>(DEFAULT_ROLE_THEME);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
	const theme = getRoleTheme(getUserInfo()?.role);
	return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export function useTheme(): RoleTheme {
	return useContext(ThemeContext);
}
