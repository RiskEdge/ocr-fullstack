import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Eye, EyeOff } from 'lucide-react';
import { login, API_BASE } from '@/lib/api';

interface PublicCompany {
	id: string;
	name: string;
}

function getDefaultRoute(role: string): string {
	if (role === 'superadmin') return '/superadmin/overview';
	if (role === 'partner_admin') return '/partner/overview';
	return '/client/overview';
}

export default function Login() {
	const [mode, setMode] = useState<'global' | 'company'>('global');
	const [companies, setCompanies] = useState<PublicCompany[]>([]);
	const [companyId, setCompanyId] = useState('');
	const [username, setUsername] = useState('');
	const [password, setPassword] = useState('');
	const [showPw, setShowPw] = useState(false);
	const [error, setError] = useState('');
	const [loading, setLoading] = useState(false);
	const navigate = useNavigate();

	useEffect(() => {
		fetch(`${API_BASE}/v1/companies`)
			.then((r) => r.json())
			.then(setCompanies)
			.catch(() => {});
	}, []);

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		setError('');

		const companyName =
			mode === 'company' ? companies.find((c) => c.id === companyId)?.name : undefined;

		if (mode === 'company' && !companyName) {
			setError('Please select a company.');
			return;
		}

		setLoading(true);
		try {
			const role = await login(username.trim(), password, companyName);
			navigate(getDefaultRoute(role));
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Login failed.');
		} finally {
			setLoading(false);
		}
	}

	const ready = username.trim() && password && (mode === 'global' || companyId);

	const fieldCls =
		'w-full px-4 py-2.5 rounded-md border border-gray-200 text-sm text-gray-900 bg-gray-50 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent focus:bg-white transition-colors';

	return (
		<div className='min-h-screen bg-gradient-to-br from-violet-700 via-indigo-800 to-indigo-950 flex items-center justify-center p-4'>
			<div className='w-full max-w-md'>
				{/* Brand */}
				<div className='flex flex-col items-center mb-8'>
					<div className='bg-white/10 backdrop-blur-sm rounded-lg px-6 py-4 mb-5 flex flex-col items-center gap-2'>
						<img
							src='/riskedge.png'
							alt='Risk Edge'
							className='h-9 w-auto brightness-0 invert'
						/>
					</div>
					<h1 className='text-2xl font-bold text-white'>Admin Dashboard</h1>
					<p className='text-sm text-indigo-200 mt-1'>Sign in to your admin account</p>
				</div>

				{/* Card */}
				<div className='bg-white rounded-lg p-8 shadow-2xl shadow-indigo-950/40'>
					{/* Mode tabs */}
					<div className='flex rounded-md border border-gray-200 overflow-hidden mb-6'>
						{(['global', 'company'] as const).map((m) => (
							<button
								key={m}
								type='button'
								onClick={() => {
									setMode(m);
									setError('');
									setCompanyId('');
								}}
								className={`flex-1 py-2 text-xs font-semibold transition-colors ${
									mode === m
										? 'bg-indigo-600 text-white'
										: 'bg-gray-50 text-gray-500 hover:bg-gray-100'
								}`}>
								{m === 'global' ? 'Partner' : 'Company Admin'}
							</button>
						))}
					</div>

					<form onSubmit={handleSubmit} className='space-y-5'>
						{mode === 'company' && (
							<div>
								<label className='block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2'>
									Company
								</label>
								<select
									value={companyId}
									onChange={(e) => {
										setCompanyId(e.target.value);
										setError('');
									}}
									className={fieldCls}>
									<option value='' disabled>
										Select a company
									</option>
									{companies.map((c) => (
										<option key={c.id} value={c.id}>
											{c.name}
										</option>
									))}
								</select>
							</div>
						)}

						<div>
							<label className='block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2'>
								Username
							</label>
							<input
								type='text'
								value={username}
								onChange={(e) => {
									setUsername(e.target.value);
									setError('');
								}}
								placeholder='Enter your username'
								required
								className={fieldCls}
							/>
						</div>

						<div>
							<label className='block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2'>
								Password
							</label>
							<div className='relative'>
								<input
									type={showPw ? 'text' : 'password'}
									value={password}
									onChange={(e) => {
										setPassword(e.target.value);
										setError('');
									}}
									placeholder='Enter your password'
									required
									className={`${fieldCls} pr-11`}
								/>
								<button
									type='button'
									onClick={() => setShowPw((p) => !p)}
									className='absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition-colors'>
									{showPw ? (
										<EyeOff className='w-4 h-4' />
									) : (
										<Eye className='w-4 h-4' />
									)}
								</button>
							</div>
						</div>

						{error && (
							<div className='bg-red-50 border border-red-200 rounded-md px-4 py-3 text-sm text-red-600'>
								{error}
							</div>
						)}

						<button
							type='submit'
							disabled={loading || !ready}
							className='w-full py-3 px-4 rounded-md bg-gradient-to-r from-violet-600 to-indigo-600 text-white text-sm font-semibold hover:from-violet-700 hover:to-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-sm shadow-indigo-200 mt-1'>
							{loading ? 'Signing in…' : 'Sign In'}
						</button>
					</form>
				</div>
			</div>
		</div>
	);
}
