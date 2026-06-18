import { useState, useEffect, useMemo } from 'react';
import { SlidersHorizontal, X } from 'lucide-react';
import { api, getUserInfo } from '@/lib/api';
import { useTheme } from '@/contexts/ThemeContext';
import type { ValidationRun, RunFilters, ClientSummary } from '@/types';
import DataTable, { type Column } from '@/components/DataTable';
import { formatDate, formatDuration, cn } from '@/lib/utils';

function StatusBadge({ status }: { status: string }) {
	return (
		<span
			className={cn(
				'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold',
				status === 'completed'
					? 'bg-emerald-100 text-emerald-700'
					: status === 'failed'
						? 'bg-red-100 text-red-700'
						: 'bg-amber-100 text-amber-700',
			)}>
			{status}
		</span>
	);
}

const labelCls = 'text-xs text-gray-400 font-medium whitespace-nowrap';

export default function ValidationRuns() {
	const theme = useTheme();
	const inputCls = `px-3 py-2 rounded-lg border border-gray-200 text-sm bg-white focus:outline-none focus:ring-2 ${theme.focusRing} focus:border-transparent transition-colors`;
	const [data, setData] = useState<ValidationRun[]>([]);
	const [clientSummaries, setClientSummaries] = useState<ClientSummary[]>([]);
	const [dateFilters, setDateFilters] = useState<Pick<RunFilters, 'from_date' | 'to_date'>>({});
	const [partnerFilter, setPartnerFilter] = useState('');
	const [companyFilter, setCompanyFilter] = useState('');
	const [userFilter, setUserFilter] = useState('');
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState('');

	const role = getUserInfo()?.role;
	const showCompany = role === 'superadmin' || role === 'partner_admin';
	const isSuperAdmin = role === 'superadmin';

	// Load full company list (with partner info for superadmin)
	useEffect(() => {
		if (showCompany) {
			api.myClients()
				.then(setClientSummaries)
				.catch(() => {});
		}
	}, [showCompany]);

	useEffect(() => {
		setLoading(true);
		setError('');
		api.validationRuns(dateFilters)
			.then(setData)
			.catch((e) => setError(String(e.message)))
			.finally(() => setLoading(false));
	}, [dateFilters]);

	// Partner options (superadmin only)
	const partnerOptions = useMemo(
		() =>
			isSuperAdmin
				? [
						...new Set(
							clientSummaries
								.map((c) => c.partner_name)
								.filter((p): p is string => !!p),
						),
					].sort()
				: [],
		[clientSummaries, isSuperAdmin],
	);

	// Company options — narrowed by partner filter when a partner is selected
	const companyOptions = useMemo(() => {
		const source =
			partnerFilter && isSuperAdmin
				? clientSummaries.filter((c) => c.partner_name === partnerFilter)
				: clientSummaries;
		return source.map((c) => c.name).sort();
	}, [partnerFilter, clientSummaries, isSuperAdmin]);

	// Company→partner map for filtering run rows
	const companyToPartner = useMemo(
		() => new Map(clientSummaries.map((c) => [c.name, c.partner_name])),
		[clientSummaries],
	);

	// Clear company filter when partner changes and it's no longer in scope
	useEffect(() => {
		if (companyFilter && companyOptions.length > 0 && !companyOptions.includes(companyFilter)) {
			setCompanyFilter('');
		}
	}, [companyOptions, companyFilter]);

	const userOptions = useMemo(() => [...new Set(data.map((r) => r.username))].sort(), [data]);

	const filteredData = useMemo(
		() =>
			data.filter(
				(r) =>
					(!partnerFilter || companyToPartner.get(r.company_name) === partnerFilter) &&
					(!companyFilter || r.company_name === companyFilter) &&
					(!userFilter || r.username === userFilter),
			),
		[data, partnerFilter, companyFilter, userFilter, companyToPartner],
	);

	const columns: Column<ValidationRun>[] = [
		{ key: 'username', header: 'User', sortable: true },
		...(showCompany
			? [{ key: 'company_name', header: 'Company', sortable: true } as Column<ValidationRun>]
			: []),
		{
			key: 'source_filename',
			header: 'File',
			sortable: true,
			render: (row) => row.source_filename ?? '—',
		},
		{ key: 'total_items', header: 'Items', sortable: true },
		{ key: 'matched_exact', header: 'Exact', sortable: true },
		{ key: 'matched_fuzzy', header: 'Fuzzy', sortable: true },
		{ key: 'matched_multi_plu', header: 'Multi-PLU', sortable: true },
		{ key: 'no_match', header: 'No Match', sortable: true },
		{ key: 'valid_items', header: 'Valid', sortable: true },
		{ key: 'items_with_issues', header: 'Issues', sortable: true },
		{ key: 'gemini_calls', header: 'AI Calls', sortable: true },
		{
			key: 'duration_ms',
			header: 'Duration',
			sortable: true,
			render: (row) => formatDuration(row.duration_ms),
		},
		{
			key: 'status',
			header: 'Status',
			sortable: true,
			render: (row) => <StatusBadge status={row.status} />,
		},
		{
			key: 'started_at',
			header: 'Started',
			sortable: true,
			render: (row) => formatDate(row.started_at),
		},
		{ key: 'environment', header: 'Env', sortable: true },
	];

	const hasFilters = !!(
		dateFilters.from_date ||
		dateFilters.to_date ||
		partnerFilter ||
		companyFilter ||
		userFilter
	);

	function clearAll() {
		setDateFilters({});
		setPartnerFilter('');
		setCompanyFilter('');
		setUserFilter('');
	}

	return (
		<div className='p-8 space-y-6 max-w-full'>
			<div>
				<h1 className='text-xl font-bold text-gray-900'>Validation Runs</h1>
				<p className='text-sm text-gray-400 mt-0.5'>All line-item validation activity</p>
			</div>

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
							value={dateFilters.from_date ?? ''}
							onChange={(e) =>
								setDateFilters((f) => ({
									...f,
									from_date: e.target.value || undefined,
								}))
							}
							className={inputCls}
						/>
						<span className='text-gray-300 text-sm'>→</span>
						<input
							type='date'
							value={dateFilters.to_date ?? ''}
							onChange={(e) =>
								setDateFilters((f) => ({
									...f,
									to_date: e.target.value || undefined,
								}))
							}
							className={inputCls}
						/>
					</div>

					{/* Partner filter — superadmin only */}
					{isSuperAdmin && (
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

					{/* Company filter */}
					{showCompany && (
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

					{/* User filter */}
					<div className='flex items-center gap-1.5'>
						<span className={labelCls}>User</span>
						<select
							value={userFilter}
							onChange={(e) => setUserFilter(e.target.value)}
							className={inputCls}>
							<option value=''>All</option>
							{userOptions.map((u) => (
								<option key={u} value={u}>
									{u}
								</option>
							))}
						</select>
					</div>

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

			{error && <p className='text-sm text-red-500'>{error}</p>}

			<DataTable
				columns={columns}
				data={filteredData}
				filename='validation-runs'
				isLoading={loading}
				headerGradient={theme.tableHeaderGradient}
			/>
		</div>
	);
}
