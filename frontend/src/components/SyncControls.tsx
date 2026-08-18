import { useState } from 'react';
import { api } from '../api/client.js';
import type { SyncResult } from '../types/index.js';

interface Props { isEnabled: boolean; hasConfig: boolean; onToggleSync: (e: boolean) => void; onSyncComplete: () => void; }

export default function SyncControls({ isEnabled, hasConfig, onToggleSync, onSyncComplete }: Props) {
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState<SyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleFullSync = async () => {
    setSyncing(true); setResult(null); setError(null);
    try { const { result } = await api.fullSync(); setResult(result); onSyncComplete(); }
    catch (err: any) { setError(err.message); }
    finally { setSyncing(false); }
  };

  return (
    <div className="sync-controls-card">
      <h3>⚡ Sync Controls</h3>
      <div className="sync-toggle">
        <label className="toggle-label">
          <span>Automatic Sync (Webhooks)</span>
          <div className={'toggle-switch ' + (isEnabled ? 'active' : '')} onClick={() => onToggleSync(!isEnabled)}>
            <div className="toggle-thumb" />
          </div>
        </label>
        <p className="toggle-description">
          {isEnabled ? 'Smartsheet changes will automatically sync to Google Calendar' : 'Enable to auto-sync changes via Smartsheet webhooks'}
        </p>
      </div>
      <div className="sync-actions">
        <button className="btn btn-accent btn-lg" onClick={handleFullSync} disabled={syncing || !hasConfig}>
          {syncing ? (<><div className="spinner spinner-sm spinner-white" />Syncing...</>) : (
            <><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20">
              <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>Full Sync</>
          )}
        </button>
      </div>
      {error && <div className="alert alert-error" style={{ marginTop: '1rem' }}><strong>Sync failed:</strong> {error}</div>}
      {result && (
        <div className="sync-result">
          <h4>Sync Complete</h4>
          <div className="sync-result-grid">
            <div className="result-item result-created"><span className="result-count">{result.created}</span><span className="result-label">Created</span></div>
            <div className="result-item result-updated"><span className="result-count">{result.updated}</span><span className="result-label">Updated</span></div>
            <div className="result-item result-deleted"><span className="result-count">{result.deleted}</span><span className="result-label">Deleted</span></div>
            <div className="result-item result-failed"><span className="result-count">{result.failed}</span><span className="result-label">Failed</span></div>
          </div>
          {result.errors.length > 0 && (
            <div className="sync-result-errors">
              {result.errors.slice(0, 5).map((e, i) => <div key={i} className="result-error-item">Row {e.rowId}: {e.error}</div>)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
