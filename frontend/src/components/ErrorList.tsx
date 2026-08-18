import { useState } from 'react';
import { api } from '../api/client.js';
import type { SyncRecord } from '../types/index.js';

interface Props { records: SyncRecord[]; onRetryComplete: () => void; }

export default function ErrorList({ records, onRetryComplete }: Props) {
  const [retrying, setRetrying] = useState<Set<string>>(new Set());

  const handleRetry = async (rowId: string) => {
    setRetrying(prev => new Set(prev).add(rowId));
    try { await api.retryRow(rowId); onRetryComplete(); }
    catch (err: any) { console.error('Retry failed:', err.message); }
    finally { setRetrying(prev => { const n = new Set(prev); n.delete(rowId); return n; }); }
  };

  const retryAll = async () => { for (const r of records) await handleRetry(r.smartsheetRowId); };

  if (records.length === 0) return (
    <div className="error-list-card"><h3>✅ No Errors</h3>
      <p className="error-empty">All records synced successfully!</p></div>
  );

  return (
    <div className="error-list-card">
      <div className="error-header">
        <h3>⚠️ Failed Records ({records.length})</h3>
        <button className="btn btn-warning btn-sm" onClick={retryAll}>Retry All</button>
      </div>
      <div className="error-table-wrapper">
        <table className="error-table">
          <thead><tr><th>Row ID</th><th>Action</th><th>Error</th><th>Retries</th><th>Last Attempt</th><th></th></tr></thead>
          <tbody>
            {records.map(r => (
              <tr key={r.id}>
                <td className="mono">{r.smartsheetRowId}</td>
                <td><span className={'action-badge action-' + r.syncAction}>{r.syncAction || 'unknown'}</span></td>
                <td className="error-message">{r.lastError}</td>
                <td className="center">{r.retryCount}</td>
                <td className="nowrap">{r.lastSyncedAt ? new Date(r.lastSyncedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '—'}</td>
                <td><button className="btn btn-ghost btn-sm" onClick={() => handleRetry(r.smartsheetRowId)} disabled={retrying.has(r.smartsheetRowId)}>
                  {retrying.has(r.smartsheetRowId) ? '↻' : 'Retry'}
                </button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
