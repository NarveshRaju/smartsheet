import { useState, useEffect } from 'react';
import { api } from '../api/client.js';
import type { Column, ColumnMapping as CMType } from '../types/index.js';

interface Props { sheetId?: string; mapping: CMType; onChange: (m: CMType) => void; disabled?: boolean; }

const FIELDS = [
  { key: 'title', label: 'Title', icon: '📝', required: true, desc: 'Event title/summary' },
  { key: 'startDate', label: 'Start Date/Time', icon: '🕐', required: true, desc: 'When the event starts' },
  { key: 'endDate', label: 'End Date/Time', icon: '🕑', required: false, desc: 'When the event ends' },
  { key: 'description', label: 'Description', icon: '📄', required: false, desc: 'Event details' },
  { key: 'location', label: 'Location', icon: '📍', required: false, desc: 'Event location' },
  { key: 'attendee', label: 'Attendees', icon: '👥', required: false, desc: 'Comma-separated emails' },
  { key: 'status', label: 'Status', icon: '🔖', required: false, desc: 'Event status mapping' },
] as const;

export default function ColumnMapping({ sheetId, mapping, onChange, disabled }: Props) {
  const [columns, setColumns] = useState<Column[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (sheetId) loadCols(); }, [sheetId]);

  const loadCols = async () => {
    if (!sheetId) return;
    setLoading(true); setError(null);
    try { const { columns: c } = await api.getSheetColumns(sheetId); setColumns(c); }
    catch (err: any) { setError(err.message); }
    finally { setLoading(false); }
  };

  if (!sheetId) return (
    <div className="mapping-card"><h3>🔗 Column Mapping</h3>
      <p className="mapping-empty">Select a Smartsheet sheet first</p></div>
  );

  return (
    <div className="mapping-card">
      <div className="selector-header">
        <h3>🔗 Column Mapping</h3>
        {loading && <div className="spinner spinner-sm" />}
      </div>
      {error && <div className="alert alert-error">{error}</div>}
      <div className="mapping-grid">
        {FIELDS.map(field => (
          <div key={field.key} className="mapping-field">
            <label className="mapping-label">
              <span className="mapping-icon">{field.icon}</span>
              <span>{field.label}{field.required && <span className="required-star">*</span>}</span>
            </label>
            <p className="mapping-description">{field.desc}</p>
            <select className="mapping-select"
              value={(mapping as any)[field.key] || ''}
              onChange={e => onChange({ ...mapping, [field.key]: e.target.value || undefined })}
              disabled={disabled || loading}>
              <option value="">— Not mapped —</option>
              {columns.map(col => <option key={col.id} value={col.id}>{col.title} ({col.type})</option>)}
            </select>
          </div>
        ))}
      </div>
    </div>
  );
}
