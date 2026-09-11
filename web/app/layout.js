export const metadata = {
	title: '🪰 Deployed by a fly',
	description: 'This site was deployed by a real spiking simulation of a fruit fly brain (FlyWire FAFB v783, 139,255 neurons) running on Railway.',
};

export default function RootLayout({ children }) {
	return (
		<html lang="en">
			<body style={{ margin: 0 }}>{children}</body>
		</html>
	);
}
