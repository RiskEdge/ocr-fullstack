import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import path from 'path';

// https://vitejs.dev/config/
export default defineConfig({
	server: {
		host: '::',
		port: 3010,
		proxy: {
			'/v1': {
				target: 'http://localhost:8010',
				changeOrigin: true,
				// Required for NDJSON streaming — disables Vite proxy response buffering
				configure: (proxy) => {
					proxy.on('proxyRes', (proxyRes) => {
						proxyRes.headers['x-accel-buffering'] = 'no';
					});
				},
			},
		},
		hmr: {
			overlay: false,
		},
		allowedHosts: ['docu-scan.riskedgesolutions.com'],
	},
	plugins: [react()],
	resolve: {
		alias: {
			'@': path.resolve(__dirname, './src'),
		},
	},
});
