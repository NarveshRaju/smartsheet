import { useState } from 'react';
import { api } from '../api/client.js';
import type { SyncResult } from '../types/index.js';

interface Props {
  isEnabled: boolean;
  hasConfig: boolean;
  isAiConfigured?: boolean;
  onToggleSync: (e: boolean) => void;
  onSyncComplete: () => void;
}

export default function SyncControls({ isEnabled, hasConfig, isAiConfigured, onToggleSync, onSyncComplete }: Props) {
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
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.5rem' }}>
        <h3 style={{ margin: 0 }}>⚡ Sync Controls</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span className={'check-badge ' + (isAiConfigured ? 'valid' : '')} style={{ fontSize: '0.75rem' }}>
            {isAiConfigured ? '🤖 AI for complex rows: Active' : '⚙️ Standard date/time parsing'}
          </span>
        </div>
      </div>
      <div className="sync-toggle">
        <label className="toggle-label">
          <span>Automatic sync</span>
          <div className={'toggle-switch ' + (isEnabled ? 'active' : '')} onClick={() => onToggleSync(!isEnabled)}>
            <div className="toggle-thumb" />
          </div>
        </label>
        <p className="toggle-description">
          {isEnabled
            ? 'Auto-sync is enabled. Changes are processed by webhooks and scheduled checks while you are away. Check the last sync time below for progress.'
            : 'Enable to auto-sync row changes from Smartsheet to Google Calendar automatically.'}
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
