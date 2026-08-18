interface ConnectionCardProps {
  provider: 'google' | 'smartsheet'; connected: boolean; label: string;
  description: string; expiry?: string;
}

export default function ConnectionCard({ provider, connected, label, description, expiry }: ConnectionCardProps) {
  const handleConnect = () => { window.location.href = '/auth/' + provider; };
  return (
    <div className={'connection-card ' + (connected ? 'connected' : 'disconnected')}>
      <div className="connection-icon" data-provider={provider}>
        {provider === 'google' ? (
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 3h18v2H3V3zm0 4h18v2H3V7zm0 4h18v2H3v-2zm0 4h18v2H3v-2zm0 4h18v2H3v-2z"/></svg>
        )}
      </div>
      <div className="connection-info">
        <h3>{label}</h3>
        <p>{description}</p>
        {connected && expiry && <span className="token-expiry">Token expires: {new Date(expiry).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</span>}
      </div>
      <div className="connection-action">
        {connected ? (
          <div className="connected-badge">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
            Connected
          </div>
        ) : (
          <button className="btn btn-primary" onClick={handleConnect}>Connect</button>
        )}
      </div>
    </div>
  );
}
