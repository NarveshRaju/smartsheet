import type { SyncStats as T } from '../types/index.js';
interface Props { stats: T | null; lastFullSyncAt?: string; }

export default function SyncStats({ stats, lastFullSyncAt }: Props) {
  if (!stats) return (
    <div className="stats-card"><h3>📊 Sync Statistics</h3>
      <p className="stats-empty">No sync data yet. Run a full sync to see statistics.</p></div>
  );

  const items = [
    { label: 'Total Records', value: stats.total, cls: 'stat-total' },
    { label: 'Synced', value: stats.synced, cls: 'stat-synced' },
    { label: 'Failed', value: stats.failed, cls: 'stat-failed' },
    { label: 'Pending', value: stats.pending, cls: 'stat-pending' },
    { label: 'Deleted', value: stats.deleted, cls: 'stat-deleted' },
  ];
  const pct = stats.total > 0 ? Math.round((stats.synced / stats.total) * 100) : 0;

  return (
    <div className="stats-card">
      <div className="stats-header">
        <h3>📊 Sync Statistics</h3>
        {lastFullSyncAt && <span className="last-sync">Last sync: {new Date(lastFullSyncAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</span>}
      </div>
      <div className="stats-progress">
        <div className="progress-bar"><div className="progress-fill" style={{ width: pct + '%' }} /></div>
        <span className="progress-label">{pct}% synced</span>
      </div>
      <div className="stats-grid">
        {items.map(i => (
          <div key={i.label} className={'stat-item ' + i.cls}>
            <span className="stat-value">{i.value}</span>
            <span className="stat-label">{i.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
