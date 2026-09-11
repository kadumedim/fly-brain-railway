// Rendered per-request so runtime env (FLY_APP_URL, injected by Railway
// operators or the mission) shows up without a rebuild.
export const dynamic = 'force-dynamic';

const styles = {
	page: {
		minHeight: '100vh',
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		background: '#0b0d11',
		backgroundImage: 'radial-gradient(rgba(139,147,163,0.13) 1.5px, transparent 1.5px)',
		backgroundSize: '36px 36px',
		color: '#e6e9ef',
		fontFamily: 'ui-sans-serif, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
		padding: '24px',
	},
	card: {
		maxWidth: '620px',
		background: '#12151c',
		border: '1px solid #232a36',
		borderRadius: '16px',
		padding: '40px 44px',
		lineHeight: 1.6,
	},
	fly: { fontSize: '64px', lineHeight: 1 },
	h1: { fontSize: '26px', margin: '18px 0 6px' },
	sub: { color: '#8b93a3', fontSize: '15px', margin: 0 },
	fact: {
		margin: '22px 0',
		padding: '14px 18px',
		background: '#0b0d11',
		border: '1px solid #232a36',
		borderRadius: '10px',
		fontSize: '14px',
	},
	mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', color: '#c084fc' },
	links: { fontSize: '13px', color: '#8b93a3' },
	a: { color: '#c084fc', textDecoration: 'none' },
	green: { color: '#4ade80' },
};

export default function Home() {
	const flyAppUrl = process.env.FLY_APP_URL || null;
	return (
		<main style={styles.page}>
			<div style={styles.card}>
				<div style={styles.fly}>🪰</div>
				<h1 style={styles.h1}>This site was deployed by a fly.</h1>
				<p style={styles.sub}>
					Not a person. Not a pipeline. A real spiking simulation of a fruit
					fly brain — all <b style={styles.green}>139,255 neurons</b> and
					~2.7M synapses of the FlyWire FAFB v783 connectome — smelled a
					virtual crumb of food on this service&apos;s node, walked over,
					ate it, and that meal fired the <span style={styles.mono}>serviceCreate</span>{' '}
					mutation that put this page on Railway.
				</p>
				<div style={styles.fact}>
					The fly lives in this very project, one service over. Its siblings:
					a Postgres it password-protected, a Redis, and a worker it wired up
					with <span style={styles.mono}>DATABASE_URL</span> and{' '}
					<span style={styles.mono}>REDIS_URL</span> — check the worker&apos;s
					logs for real <span style={styles.mono}>SELECT 1</span> heartbeats.
				</div>
				<p style={styles.links}>
					{flyAppUrl && (
						<>
							<a style={styles.a} href={flyAppUrl}>▶ watch the fly live</a>
							{' · '}
						</>
					)}
					<a style={styles.a} href="https://github.com/kadumedim/fly-brain-railway">source</a>
					{' · '}
					<a style={styles.a} href="https://flywire.ai">FlyWire connectome (CC-BY-NC)</a>
					{' · '}
					sim adapted from{' '}
					<a style={styles.a} href="https://github.com/snedea/flybrain">snedea/flybrain</a>
				</p>
			</div>
		</main>
	);
}
