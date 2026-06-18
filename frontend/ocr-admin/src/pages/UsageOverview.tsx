import { useState, useEffect, useMemo } from 'react';
import { SlidersHorizontal, X, Building2, Users2, Handshake } from 'lucide-react';
import { api, getUserInfo } from '@/lib/api';
import type { CompanyUsage, UserUsage, PartnerUsage, UsageOverviewData } from '@/types';
import DataTable, { type Column } from '@/components/DataTable';
import { cn } from '@/lib/utils';
import { useTheme } from '@/contexts/ThemeContext';

const labelCls = 'text-xs text-gray-400 font-medium whitespace-nowrap';

type Tab = 'partner' | 'company' | 'user';

export default function UsageOverview() {
	const [tab, setTab] = useState<Tab>('company');
	const [data, setData] = useState<UsageOverviewData | null>(null);
	const [fromDate, setFromDate] = useState('');
	const [toDate, setToDate] = useState('');
	const [partnerFilter, setPartnerFilter] = useState('');
	const [companyFilter, setCompanyFilter] = useState('');
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState('');

	const role = getUserInfo()?.role;
	const isSuperAdmin = role === 'superadmin';
	const showCompany = role === 'superadmin' || role === 'partner_admin';
	const theme = useTheme();
	const inputCls = `px-3 py-2 rounded-lg border border-gray-200 text-sm bg-white focus:outline-none focus:ring-2 ${theme.focusRing} focus:border-transparent transition-colors`;

	useEffect(() => {
		setLoading(true);
		setError('');
		api.usageOverview({ from_date: fromDate || undefined, to_date: toDate || undefined })
			.then(setData)
			.catch((e) => setError(String(e.message)))
			.finally(() => setLoading(false));
	}, [fromDate, toDate]);

	// All partner names (superadmin only)
	const partnerOptions = useMemo(
		() =>
			isSuperAdmin
				? [
						...new Set(
							(data?.by_company ?? []).map((c) => c.partner_name).filter(Boolean),
						),
					].sort()
				: [],
		[data, isSuperAdmin],
	);

	// Company options for By User tab — narrowed by partner filter when set
	const companyOptions = useMemo(() => {
		const source = data?.by_company ?? [];
		const filtered = partnerFilter
			? source.filter((c) => c.partner_name === partnerFilter)
			: source;
		return filtered.map((c) => c.company_name).sort();
	}, [data, partnerFilter]);

	// Clear company filter when it falls out of scope after partner changes
	useEffect(() => {
		if (companyFilter && companyOptions.length > 0 && !companyOptions.includes(companyFilter)) {
			setCompanyFilter('');
		}
	}, [companyOptions, companyFilter]);

	// Filtered By Company data
	const filteredCompanies = useMemo(
		() =>
			(data?.by_company ?? []).filter(
				(c) => !partnerFilter || c.partner_name === partnerFilter,
			),
		[data, partnerFilter],
	);

	// Filtered By User data
	const filteredUsers = useMemo(
		() =>
			(data?.by_user ?? []).filter(
				(u) =>
					(!partnerFilter || u.partner_name === partnerFilter) &&
					(!companyFilter || u.company_name === companyFilter),
			),
		[data, partnerFilter, companyFilter],
	);

	const hasFilters = !!(fromDate || toDate || partnerFilter || companyFilter);

	function clearAll() {
		setFromDate('');
		setToDate('');
		setPartnerFilter('');
		setCompanyFilter('');
	}

	// Show/hide filter controls per tab
	const showPartnerFilter = isSuperAdmin && tab !== 'partner';
	const showCompanyFilter = showCompany && tab === 'user';

	// Column definitions
	const fmtCost = (val: number) => `₹${val.toFixed(2)}`;

	const partnerColumns: Column<PartnerUsage>[] = [
		{ key: 'partner_name', header: 'Partner', sortable: true },
		{ key: 'company_count', header: 'Companies', sortable: true },
		{ key: 'ocr_runs', header: 'OCR Runs', sortable: true },
		{ key: 'ocr_pages', header: 'OCR Pages', sortable: true },
		{ key: 'ocr_credits', header: 'OCR Credits', sortable: true },
		{ key: 'val_runs', header: 'Val Runs', sortable: true },
		{ key: 'val_items', header: 'Val Items', sortable: true },
		{ key: 'total_cost', header: 'Total Cost (₹)', sortable: true, render: (row: PartnerUsage) => fmtCost(row.total_cost) },
	];

	const companyColumns: Column<CompanyUsage>[] = [
		{ key: 'company_name', header: 'Company', sortable: true },
		...(isSuperAdmin
			? [{ key: 'partner_name' as const, header: 'Partner', sortable: true }]
			: []),
		{ key: 'ocr_runs', header: 'OCR Runs', sortable: true },
		{ key: 'ocr_pages', header: 'OCR Pages', sortable: true },
		{ key: 'ocr_credits', header: 'OCR Credits', sortable: true },
		{ key: 'val_runs', header: 'Val Runs', sortable: true },
		{ key: 'val_items', header: 'Val Items', sortable: true },
		{ key: 'total_cost', header: 'Total Cost (₹)', sortable: true, render: (row: CompanyUsage) => fmtCost(row.total_cost) },
	];

	const userColumns: Column<UserUsage>[] = [
		{ key: 'username', header: 'User', sortable: true },
		...(showCompany
			? [{ key: 'company_name' as const, header: 'Company', sortable: true }]
			: []),
		...(isSuperAdmin
			? [{ key: 'partner_name' as const, header: 'Partner', sortable: true }]
			: []),
		{ key: 'ocr_runs', header: 'OCR Runs', sortable: true },
		{ key: 'ocr_pages', header: 'OCR Pages', sortable: true },
		{ key: 'ocr_credits', header: 'OCR Credits', sortable: true },
		{ key: 'val_runs', header: 'Val Runs', sortable: true },
		{ key: 'val_items', header: 'Val Items', sortable: true },
		{ key: 'total_cost', header: 'Total Cost (₹)', sortable: true, render: (row: UserUsage) => fmtCost(row.total_cost) },
	];

	function switchTab(t: Tab) {
		setTab(t);
		// Keep date + partner filters, clear company filter when moving away from user tab
		if (t !== 'user') setCompanyFilter('');
	}

	return (
		<div className='p-8 space-y-6 max-w-full'>
			<div>
				<h1 className='text-xl font-bold text-gray-900'>Usage Overview</h1>
				<p className='text-sm text-gray-400 mt-0.5'>
					Aggregated activity for partner by company and user
				</p>
			</div>

			{/* Filters */}
			<div className='bg-white rounded-lg border border-gray-100 shadow-sm px-5 py-4'>
				<div className='flex flex-wrap items-center gap-3'>
					<div className='flex items-center gap-2 text-sm text-gray-400 font-medium'>
						<SlidersHorizontal className='h-4 w-4' />
						Filters
					</div>

					{/* Date range */}
					<div className='flex items-center gap-2'>
						<input
							type='date'
							value={fromDate}
							onChange={(e) => setFromDate(e.target.value)}
							className={inputCls}
						/>
						<span className='text-gray-300 text-sm'>→</span>
						<input
							type='date'
							value={toDate}
							onChange={(e) => setToDate(e.target.value)}
							className={inputCls}
						/>
					</div>

					{/* Partner filter — superadmin, hidden on By Partner tab */}
					{showPartnerFilter && (
						<div className='flex items-center gap-1.5'>
							<span className={labelCls}>Partner</span>
							<select
								value={partnerFilter}
								onChange={(e) => {
									setPartnerFilter(e.target.value);
									setCompanyFilter('');
								}}
								className={inputCls}>
								<option value=''>All</option>
								{partnerOptions.map((p) => (
									<option key={p} value={p}>
										{p}
									</option>
								))}
							</select>
						</div>
					)}

					{/* Company filter — By User tab only */}
					{showCompanyFilter && (
						<div className='flex items-center gap-1.5'>
							<span className={labelCls}>Company</span>
							<select
								value={companyFilter}
								onChange={(e) => setCompanyFilter(e.target.value)}
								className={inputCls}>
								<option value=''>All</option>
								{companyOptions.map((c) => (
									<option key={c} value={c}>
										{c}
									</option>
								))}
							</select>
						</div>
					)}

					{hasFilters && (
						<button
							onClick={clearAll}
							className='flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold text-gray-500 hover:text-red-500 hover:bg-red-50 border border-gray-200 transition-colors'>
							<X className='h-3.5 w-3.5' />
							Clear
						</button>
					)}
				</div>
			</div>

			{/* Tabs */}
			<div className='flex gap-1 bg-gray-100 rounded-lg p-1 w-fit'>
				{isSuperAdmin && (
					<button
						onClick={() => switchTab('partner')}
						className={cn(
							'flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all',
							tab === 'partner' ? theme.activeTabClass : 'text-gray-500 hover:text-gray-700',
						)}>
						<Handshake className='h-4 w-4' />
						By Partner
					</button>
				)}
				<button
					onClick={() => switchTab('company')}
					className={cn(
						'flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all',
						tab === 'company' ? theme.activeTabClass : 'text-gray-500 hover:text-gray-700',
					)}>
					<Building2 className='h-4 w-4' />
					By Company
				</button>
				<button
					onClick={() => switchTab('user')}
					className={cn(
						'flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all',
						tab === 'user' ? theme.activeTabClass : 'text-gray-500 hover:text-gray-700',
					)}>
					<Users2 className='h-4 w-4' />
					By User
				</button>
			</div>

			{error && <p className='text-sm text-red-500'>{error}</p>}

			{tab === 'partner' && (
				<DataTable
					columns={partnerColumns}
					data={data?.by_partner ?? []}
					filename='usage-by-partner'
					isLoading={loading}
					headerGradient={theme.tableHeaderGradient}
					showTotals={isSuperAdmin}
				/>
			)}

			{tab === 'company' && (
				<DataTable
					columns={companyColumns}
					data={filteredCompanies}
					filename='usage-by-company'
					isLoading={loading}
					headerGradient={theme.tableHeaderGradient}
					showTotals={isSuperAdmin}
				/>
			)}

			{tab === 'user' && (
				<DataTable
					columns={userColumns}
					data={filteredUsers}
					filename='usage-by-user'
					isLoading={loading}
					headerGradient={theme.tableHeaderGradient}
					showTotals={isSuperAdmin}
				/>
			)}
		</div>
	);
}
