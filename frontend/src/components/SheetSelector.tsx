import { useState, useEffect } from 'react';
import { api } from '../api/client.js';
import type { Sheet } from '../types/index.js';

interface Props { selectedSheetId?: string; onSelect: (sheet: Sheet) => void; disabled?: boolean; }

export default function SheetSelector({ selectedSheetId, onSelect, disabled }: Props) {
  const [sheets, setSheets] = useState<Sheet[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  useEffect(() => { loadSheets(); }, []);

  const loadSheets = async () => {
    setLoading(true); setError(null);
    try { const { sheets } = await api.getSheets(); setSheets(sheets); }
    catch (err: any) { setError(err.message); }
    finally { setLoading(false); }
  };

  const filtered = sheets.filter(s => s.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="selector-card">
      <div className="selector-header">
        <h3>📋 Smartsheet Sheet</h3>
        <button className="btn btn-ghost btn-sm" onClick={loadSheets} disabled={loading}>
          {loading ? '↻' : '↻ Refresh'}
        </button>
      </div>
      {error && <div className="alert alert-error">{error}</div>}
      <div className="selector-search">
        <input type="text" placeholder="Search sheets..." value={search}
          onChange={e => setSearch(e.target.value)} disabled={disabled || loading} />
      </div>
      <div className="selector-list">
        {loading ? (
          <div className="selector-loading"><div className="spinner" />Loading sheets...</div>
        ) : filtered.length === 0 ? (
          <div className="selector-empty">No sheets found</div>
        ) : filtered.map(sheet => (
          <button key={sheet.id}
            className={'selector-item ' + (selectedSheetId === sheet.id ? 'selected' : '')}
            onClick={() => onSelect(sheet)} disabled={disabled}>
            <span className="selector-item-name">{sheet.name}</span>
            <span className="selector-item-meta">{sheet.accessLevel}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
