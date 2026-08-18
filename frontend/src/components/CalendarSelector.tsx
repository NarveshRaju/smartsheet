import { useState, useEffect } from 'react';
import { api } from '../api/client.js';
import type { Calendar } from '../types/index.js';

interface Props { selectedCalendarId?: string; onSelect: (cal: Calendar) => void; disabled?: boolean; }

export default function CalendarSelector({ selectedCalendarId, onSelect, disabled }: Props) {
  const [calendars, setCalendars] = useState<Calendar[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { load(); }, []);

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const { calendars: list } = await api.getCalendars();
      setCalendars(list);
      if (list.length > 0 && !selectedCalendarId) {
        const primary = list.find((c) => c.primary) || list[0];
        if (primary) onSelect(primary);
      }
    }
    catch (err: any) { setError(err.message); }
    finally { setLoading(false); }
  };

  return (
    <div className="selector-card">
      <div className="selector-header">
        <h3>📅 Google Calendar</h3>
        <button className="btn btn-ghost btn-sm" onClick={load} disabled={loading}>
          {loading ? '↻' : '↻ Refresh'}
        </button>
      </div>
      {error && <div className="alert alert-error">{error}</div>}
      <div className="selector-list">
        {loading ? (
          <div className="selector-loading"><div className="spinner" />Loading calendars...</div>
        ) : calendars.length === 0 ? (
          <div className="selector-empty">No calendars found</div>
        ) : calendars.map(cal => (
          <button key={cal.id}
            className={'selector-item ' + (selectedCalendarId === cal.id ? 'selected' : '')}
            onClick={() => onSelect(cal)} disabled={disabled}>
            <span className="calendar-color-dot" style={{ backgroundColor: cal.backgroundColor || '#4285f4' }} />
            <span className="selector-item-name">
              {cal.summary}
              {cal.primary && <span className="badge-primary">Primary</span>}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
