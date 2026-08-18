import { useState, useEffect } from 'react';
import { api } from '../api/client.js';
import type { Column, ColumnMapping as CMType } from '../types/index.js';

interface Props { sheetId?: string; mapping: CMType; onChange: (m: CMType) => void; disabled?: boolean; }

const FIELDS = [
  { key: 'title', label: 'Event Title / Summary', icon: '📝', required: true, desc: 'Name of the event' },
  { key: 'startDate', label: 'Start Date (or Date & Time)', icon: '📅', required: true, desc: 'Date (or combined DateTime) column' },
  { key: 'startTime', label: 'Start Time (Optional)', icon: '🕐', required: false, desc: 'Separate time column (e.g. 10:00 AM)' },
  { key: 'endDate', label: 'End Date', icon: '📅', required: false, desc: 'End date column (optional)' },
  { key: 'endTime', label: 'End Time (Optional)', icon: '🕑', required: false, desc: 'Separate end time column (e.g. 11:30 AM)' },
  { key: 'description', label: 'Description / Notes', icon: '📄', required: false, desc: 'Event details / body text' },
  { key: 'location', label: 'Location / Link', icon: '📍', required: false, desc: 'Event location or meeting link' },
  { key: 'attendee', label: 'Attendees (Emails)', icon: '👥', required: false, desc: 'Comma-separated guest emails' },
  { key: 'status', label: 'Status', icon: '🔖', required: false, desc: 'Status (Confirmed / Tentative / Cancelled)' },
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
