import { useState, useEffect } from 'react';
import { CreditCard, Users, Zap, IndianRupee } from 'lucide-react';
import { api, getUserInfo } from '@/lib/api';
import type { OverviewData } from '@/types';
import StatCard from '@/components/StatCard';
import { useTheme } from '@/contexts/ThemeContext';
import { cn } from '@/lib/utils';

interface StatDef {
	key: string;
	label: string;
}

function ComparisonCard({
	title,
	gradient,
	allTime,
	last30d,
	statDefs,
}: {
	title: string;
	gradient: string;
	allTime: Record<string, number>;
	last30d: Record<string, number>;
	statDefs: Array<{ key: string; label: string }>;
}) {
	const sections = [
		{ period: 'All Time', values: allTime },
		{ period: 'Last 30 Days', values: last30d },
	];
	return (
		<div className='bg-white rounded-lg border border-gray-200 overflow-hidden shadow-sm'>
			<div className={`bg-gradient-to-r ${gradient} px-6 py-3.5`}>
				<h3 className='text-white font-semibold text-sm tracking-wide'>{title}</h3>
			</div>
			{sections.map((s, i) => (
				<div key={s.period} className={i > 0 ? 'border-t border-gray-100' : ''}>
					<p className='px-6 pt-4 pb-2 text-xs font-bold text-gray-400 uppercase tracking-widest'>
						{s.period}
					</p>
					<div className='px-6 pb-5 grid grid-cols-4 gap-4'>
						{statDefs.map(({ key, label }) => (
							<div key={key}>
								<p className='text-2xl font-bold text-gray-900'>
									{(s.values[key] ?? 0).toLocaleString()}
								</p>
								<p className='text-xs text-gray-400 mt-1'>{label}</p>
							</div>
						))}
					</div>
				</div>
			))}
		</div>
	);
}

const ocrStats: StatDef[] = [
	{ key: 'runs', label: 'Runs' },
	{ key: 'files', label: 'Files Processed' },
	{ key: 'pages', label: 'Pages Extracted' },
	{ key: 'credits', label: 'Credits Used' },
];

const valStats: StatDef[] = [
	{ key: 'runs', label: 'Runs' },
	{ key: 'items', label: 'Items Validated' },
	{ key: 'gemini_calls', label: 'AI Calls' },
];

export default function Overview() {
	const [data, setData] = useState<OverviewData | null>(null);
	const [error, setError] = useState('');
	const role = getUserInfo()?.role;
	const theme = useTheme();

	useEffect(() => {
		api.overview()
			.then(setData)
			.catch((e) => setError(String(e.message)));
	}, []);

	if (error) {
		return (
			<div className='flex items-center justify-center h-64 text-sm text-red-500'>
				{error}
			</div>
		);
	}
	if (!data) {
		return (
			<div className='flex items-center justify-center h-64'>
				<div className='flex flex-col items-center gap-3'>
					<div className={cn('w-8 h-8 border-2 border-t-transparent rounded-full animate-spin', theme.spinner)} />
					<p className='text-sm text-gray-400'>Loading…</p>
				</div>
			</div>
		);
	}

	const { ocr, validation } = data;

	return (
		<div className='p-8 space-y-8 max-w-5xl'>
			{/* Header */}
			<div className='flex items-start justify-between'>
				<div>
					<h1 className='text-2xl font-bold text-gray-900'>{data.company_name}</h1>
					<p className='text-sm text-gray-400 mt-0.5'>Company overview</p>
				</div>
				<span className={cn('inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold', theme.badge)}>
					{role === 'superadmin' ? 'Super Admin' : 'Company Admin'}
				</span>
			</div>

			{/* Headline metrics */}
			<section>
				<p className='text-xs font-semibold text-gray-400 uppercase tracking-widest mb-4'>
					At a Glance
				</p>
				<div className={cn('grid gap-4', data.total_billing_cost !== undefined ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-1 sm:grid-cols-3')}>
					<StatCard variant={1} icon={CreditCard}    label='Credits Remaining' value={data.credits_remaining.toLocaleString()} />
					<StatCard variant={2} icon={Users}          label='Total Users'        value={data.total_users} />
					<StatCard variant={3} icon={Zap}            label='Credits Consumed'   value={data.total_credits_consumed.toLocaleString()} />
					{data.total_billing_cost !== undefined && (
						<StatCard variant={4} icon={IndianRupee} label='Total Cost (₹)'    value={`₹${data.total_billing_cost.toFixed(2)}`} />
					)}
				</div>
			</section>

			{/* OCR */}
			<section>
				<p className='text-xs font-semibold text-gray-400 uppercase tracking-widest mb-4'>
					OCR Processing
				</p>
				<ComparisonCard
					title='OCR Processing'
					gradient={theme.compCard1}
					allTime={ocr.all_time as unknown as Record<string, number>}
					last30d={ocr.last_30d as unknown as Record<string, number>}
					statDefs={ocrStats}
				/>
			</section>

			{/* Validation */}
			<section>
				<p className='text-xs font-semibold text-gray-400 uppercase tracking-widest mb-4'>
					Validation
				</p>
				<ComparisonCard
					title='Validation'
					gradient={theme.compCard2}
					allTime={validation.all_time as unknown as Record<string, number>}
					last30d={validation.last_30d as unknown as Record<string, number>}
					statDefs={valStats}
				/>
			</section>

			{/* Cost by User */}
			{data.by_user && data.by_user.length > 0 && (
				<section>
					<p className='text-xs font-semibold text-gray-400 uppercase tracking-widest mb-4'>
						Cost by User
					</p>
					<div className='bg-white rounded-lg border border-gray-200 overflow-hidden shadow-sm'>
						<div className={`bg-gradient-to-r ${theme.compCard1} px-6 py-3.5`}>
							<h3 className='text-white font-semibold text-sm tracking-wide'>
								OCR Processing Cost Breakdown
							</h3>
						</div>
						<div className='overflow-x-auto'>
							<table className='w-full text-sm'>
								<thead>
									<tr className='border-b border-gray-100 bg-gray-50'>
										<th className='px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide'>User</th>
										<th className='px-6 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wide'>Invoices Processed</th>
										<th className='px-6 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wide'>Rate / Invoice</th>
										<th className='px-6 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wide'>Total Cost</th>
									</tr>
								</thead>
								<tbody className='divide-y divide-gray-50'>
									{data.by_user.map((u, i) => (
										<tr key={u.user_id} className={i % 2 !== 0 ? 'bg-gray-50/50' : ''}>
											<td className='px-6 py-3 font-medium text-gray-900'>{u.username}</td>
											<td className='px-6 py-3 text-right text-gray-600'>{u.ocr_invoices.toLocaleString()}</td>
											<td className='px-6 py-3 text-right text-gray-500'>₹{u.price_per_invoice.toFixed(2)}</td>
											<td className='px-6 py-3 text-right font-semibold text-gray-900'>₹{u.total_cost.toFixed(2)}</td>
										</tr>
									))}
									<tr className='border-t-2 border-gray-200 bg-gray-100'>
										<td className='px-6 py-3 text-xs font-bold text-gray-500 uppercase tracking-wide'>Total</td>
										<td className='px-6 py-3 text-right font-bold text-gray-900'>
											{data.by_user.reduce((s, u) => s + u.ocr_invoices, 0).toLocaleString()}
										</td>
										<td className='px-6 py-3' />
										<td className='px-6 py-3 text-right font-bold text-gray-900'>
											₹{data.total_billing_cost?.toFixed(2)}
										</td>
									</tr>
								</tbody>
							</table>
						</div>
					</div>
				</section>
			)}
		</div>
	);
}
