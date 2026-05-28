import { useState, useEffect } from 'react';
import { Globe, Building2, Users, CreditCard } from 'lucide-react';
import { api } from '@/lib/api';
import type { GlobalOverviewData } from '@/types';
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
	statDefs: StatDef[];
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

const ocrStatDefs: StatDef[] = [
	{ key: 'runs', label: 'Runs' },
	{ key: 'files', label: 'Files Processed' },
	{ key: 'pages', label: 'Pages Extracted' },
	{ key: 'credits', label: 'Credits Used' },
];
const valStatDefs: StatDef[] = [
	{ key: 'runs', label: 'Runs' },
	{ key: 'items', label: 'Items Validated' },
	{ key: 'credits', label: 'Credits Used' },
	{ key: 'gemini_calls', label: 'AI Calls' },
];

export default function SuperAdminOverview() {
	const theme = useTheme();
	const [data, setData] = useState<GlobalOverviewData | null>(null);
	const [error, setError] = useState('');

	useEffect(() => {
		api.globalOverview()
			.then(setData)
			.catch((e) => setError(String(e.message)));
	}, []);

	if (error)
		return (
			<div className='flex items-center justify-center h-64 text-sm text-red-500'>
				{error}
			</div>
		);
	if (!data)
		return (
			<div className='flex items-center justify-center h-64'>
				<div className='flex flex-col items-center gap-3'>
					<div className={cn('w-8 h-8 border-2 border-t-transparent rounded-full animate-spin', theme.spinner)} />
					<p className='text-sm text-gray-400'>Loading…</p>
				</div>
			</div>
		);

	return (
		<div className='p-8 space-y-8 max-w-5xl'>
			<div className='flex items-start justify-between'>
				<div>
					<h1 className='text-2xl font-bold text-gray-900'>Global Overview</h1>
					<p className='text-sm text-gray-400 mt-0.5'>
						Platform-wide stats across all partners and clients
					</p>
				</div>
				<span className={cn('inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold', theme.badge)}>
					Super Admin
				</span>
			</div>

			<section>
				<p className='text-xs font-semibold text-gray-400 uppercase tracking-widest mb-4'>
					Platform At a Glance
				</p>
				<div className='grid grid-cols-2 sm:grid-cols-4 gap-4'>
					<StatCard variant={1} icon={Globe}     label='Partners'          value={data.total_partners} />
					<StatCard variant={2} icon={Building2} label='Client Companies'   value={data.total_companies} />
					<StatCard variant={3} icon={Users}     label='Active Users'       value={data.total_users} />
					<StatCard variant={4} icon={CreditCard} label='Credits in System' value={data.total_credits_in_system.toLocaleString()} />
				</div>
			</section>

			<section>
				<p className='text-xs font-semibold text-gray-400 uppercase tracking-widest mb-4'>
					OCR Processing
				</p>
				<ComparisonCard
					title='OCR Processing'
					gradient={theme.compCard1}
					allTime={data.ocr.all_time as unknown as Record<string, number>}
					last30d={data.ocr.last_30d as unknown as Record<string, number>}
					statDefs={ocrStatDefs}
				/>
			</section>

			<section>
				<p className='text-xs font-semibold text-gray-400 uppercase tracking-widest mb-4'>
					Validation
				</p>
				<ComparisonCard
					title='Validation'
					gradient={theme.compCard2}
					allTime={data.validation.all_time as unknown as Record<string, number>}
					last30d={data.validation.last_30d as unknown as Record<string, number>}
					statDefs={valStatDefs}
				/>
			</section>
		</div>
	);
}
