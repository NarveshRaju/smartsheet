import { useState, useEffect } from 'react';
import { api } from '../api/client.js';
import type { Column, ColumnMapping as CMType } from '../types/index.js';

interface Props { sheetId?: string; mapping: CMType; onChange: (m: CMType) => void; disabled?: boolean; }

const FIELDS = [
  { key: 'title', label: 'Event Title / Summary', icon: '📝', required: true, desc: 'Name of the event' },
  { key: 'startDate', label: 'Start Date', icon: '📅', required: true, desc: 'Mandatory date column (e.g. 2026-08-18)' },
  { key: 'startTime', label: 'Start Time', icon: '🕐', required: false, desc: 'Mandatory time column (e.g. 10:00 AM or All Day)' },
  { key: 'endDate', label: 'End Date', icon: '📅', required: false, desc: 'Optional end date column' },
  { key: 'endTime', label: 'End Time', icon: '🕑', required: false, desc: 'Optional end time column (e.g. 11:30 AM)' },
  { key: 'description', label: 'Description / Notes', icon: '📄', required: false, desc: 'Event details / body text' },
  { key: 'location', label: 'Location / Link', icon: '📍', required: false, desc: 'Event location or meeting link' },
  { key: 'attendee', label: 'Attendees (Emails)', icon: '👥', required: false, desc: 'Comma-separated guest emails' },
  { key: 'status', label: 'Status', icon: '🔖', required: false, desc: 'Status (Confirmed / Tentative / Cancelled)' },
  { key: 'color', label: 'Event Color / Sub-Category', icon: '🎨', required: false, desc: 'Optional: assigns Google Calendar event color from cell color, code, or subcategory' },
] as const;

export default function ColumnMapping({ sheetId, mapping, onChange, disabled }: Props) {
  const [columns, setColumns] = useState<Column[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (sheetId) loadCols(); }, [sheetId]);

  const loadCols = async () => {
    if (!sheetId) return;
    setLoading(true); setError(null);
    try {
      const { columns: c } = await api.getSheetColumns(sheetId);
      setColumns(c);
      if (c && c.length > 0 && Object.keys(mapping).length === 0) {
        const auto: CMType = {};
        for (const col of c) {
          const lower = col.title.toLowerCase();
          if (!auto.title && (lower.includes('event name') || lower.includes('title') || lower.includes('summary') || lower.includes('task name'))) {
            auto.title = col.id;
          } else if (!auto.startDate && (lower.includes('start date') || lower.includes('promo start') || lower === 'date')) {
            auto.startDate = col.id;
          } else if (!auto.endDate && (lower.includes('end date') || lower.includes('promo end'))) {
            auto.endDate = col.id;
          } else if (!auto.startTime && lower.includes('start time')) {
            auto.startTime = col.id;
          } else if (!auto.color && (lower.includes('sub-category') || lower.includes('subcategory') || lower.includes('color'))) {
            auto.color = col.id;
          }
        }
        if (Object.keys(auto).length > 0) {
          onChange({ ...mapping, ...auto });
        }
      }
    }
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
