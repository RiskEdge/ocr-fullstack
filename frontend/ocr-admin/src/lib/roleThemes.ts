export interface RoleTheme {
	// Sidebar
	sidebarGradient: string;
	sidebarActiveText: string;
	sidebarInactiveText: string;
	sidebarHoverText: string;
	sidebarMutedText: string;
	sidebarAvatarText: string;
	// Table / DataTable
	tableHeaderGradient: string;
	rowHover: string;
	paginationGradient: string;
	spinner: string;
	// Buttons & inputs
	primaryBtn: string;
	focusRing: string;
	// Accent (badges, accordion, icons, labels)
	badge: string;
	accentBg: string;
	accentBorder: string;
	accentText: string;
	accentTextStrong: string;
	// Tab / toggle active state
	activeTabClass: string;
	hoverAccentText: string;
	// ComparisonCard headers (Overview pages)
	compCard1: string;
	compCard2: string;
	// StatCard variants (index 0–3)
	statCards: [string, string, string, string];
}

export const ROLE_THEMES: Record<string, RoleTheme> = {
	// ─── Superadmin: Purple sidebar + Indigo accents ───────────────────────────
	superadmin: {
		sidebarGradient:     'from-purple-950 via-purple-900 to-slate-900',
		sidebarActiveText:   'text-indigo-400',
		sidebarInactiveText: 'text-purple-300',
		sidebarHoverText:    'hover:text-white',
		sidebarMutedText:    'text-purple-400',
		sidebarAvatarText:   'text-indigo-600',

		tableHeaderGradient: 'from-indigo-500 to-indigo-700',
		rowHover:            'hover:bg-indigo-50',
		paginationGradient:  'from-indigo-500 to-indigo-600',
		spinner:             'border-indigo-600',

		primaryBtn: 'bg-indigo-600 hover:bg-indigo-700 text-white',
		focusRing:  'focus:ring-indigo-400',

		badge:            'bg-indigo-50 text-indigo-700 border border-indigo-200',
		accentBg:         'bg-indigo-50',
		accentBorder:     'border-indigo-200',
		accentText:       'text-indigo-500',
		accentTextStrong: 'text-indigo-700',
		activeTabClass:   'bg-white text-indigo-700 shadow-sm',
		hoverAccentText:  'hover:text-indigo-500',

		compCard1: 'from-purple-700 to-purple-950',
		compCard2: 'from-indigo-500 to-indigo-700',

		statCards: [
			'from-indigo-400 to-indigo-600',
			'from-indigo-500 to-violet-600',
			'from-violet-500 to-indigo-700',
			'from-indigo-600 to-indigo-800',
		],
	},

	// ─── Partner Admin: Teal sidebar + Sky Blue accents ────────────────────────
	partner_admin: {
		sidebarGradient:     'from-teal-950 via-teal-900 to-slate-900',
		sidebarActiveText:   'text-sky-400',
		sidebarInactiveText: 'text-teal-300',
		sidebarHoverText:    'hover:text-white',
		sidebarMutedText:    'text-teal-400',
		sidebarAvatarText:   'text-sky-600',

		tableHeaderGradient: 'from-sky-500 to-sky-700',
		rowHover:            'hover:bg-sky-50',
		paginationGradient:  'from-sky-500 to-sky-600',
		spinner:             'border-sky-600',

		primaryBtn: 'bg-sky-600 hover:bg-sky-700 text-white',
		focusRing:  'focus:ring-sky-400',

		badge:            'bg-sky-50 text-sky-700 border border-sky-200',
		accentBg:         'bg-sky-50',
		accentBorder:     'border-sky-200',
		accentText:       'text-sky-500',
		accentTextStrong: 'text-sky-700',
		activeTabClass:   'bg-white text-sky-700 shadow-sm',
		hoverAccentText:  'hover:text-sky-500',

		compCard1: 'from-teal-700 to-teal-950',
		compCard2: 'from-sky-500 to-sky-700',

		statCards: [
			'from-sky-400 to-sky-600',
			'from-sky-500 to-teal-600',
			'from-teal-500 to-sky-700',
			'from-sky-600 to-sky-800',
		],
	},

	// ─── Client Admin: Rose sidebar + Pink accents ──────────────────────────────
	client_admin: {
		sidebarGradient:     'from-rose-950 via-rose-900 to-slate-900',
		sidebarActiveText:   'text-pink-400',
		sidebarInactiveText: 'text-rose-300',
		sidebarHoverText:    'hover:text-white',
		sidebarMutedText:    'text-rose-400',
		sidebarAvatarText:   'text-rose-600',

		tableHeaderGradient: 'from-pink-500 to-rose-600',
		rowHover:            'hover:bg-rose-50',
		paginationGradient:  'from-pink-500 to-rose-500',
		spinner:             'border-rose-600',

		primaryBtn: 'bg-rose-600 hover:bg-rose-700 text-white',
		focusRing:  'focus:ring-rose-400',

		badge:            'bg-rose-50 text-rose-700 border border-rose-200',
		accentBg:         'bg-rose-50',
		accentBorder:     'border-rose-200',
		accentText:       'text-rose-500',
		accentTextStrong: 'text-rose-700',
		activeTabClass:   'bg-white text-rose-700 shadow-sm',
		hoverAccentText:  'hover:text-rose-500',

		compCard1: 'from-rose-700 to-rose-950',
		compCard2: 'from-pink-500 to-rose-600',

		statCards: [
			'from-rose-400 to-rose-600',
			'from-pink-500 to-rose-600',
			'from-rose-500 to-pink-700',
			'from-rose-600 to-rose-800',
		],
	},
};

export const DEFAULT_ROLE_THEME = ROLE_THEMES.superadmin;

export function getRoleTheme(role?: string): RoleTheme {
	return ROLE_THEMES[role ?? ''] ?? DEFAULT_ROLE_THEME;
}
