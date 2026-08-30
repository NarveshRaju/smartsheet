import { useState, useEffect } from 'react';
import { api } from '../api/client.js';
import type { Calendar } from '../types/index.js';

interface Props {
  selectedCalendarId?: string;
  onSelect: (cal: Calendar) => void;
  disabled?: boolean;
}

export default function CalendarSelector({ selectedCalendarId, onSelect, disabled }: Props) {
  const [calendars, setCalendars] = useState<Calendar[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  // New Calendar creation state
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newCalendarName, setNewCalendarName] = useState('');
  const [newCalendarDesc, setNewCalendarDesc] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  useEffect(() => {
    loadCalendars();
  }, []);

  const loadCalendars = async (autoSelectId?: string) => {
    setLoading(true);
    setError(null);
    try {
      const { calendars: list } = await api.getCalendars();
      setCalendars(list);

      if (autoSelectId) {
        const found = list.find((c) => c.id === autoSelectId);
        if (found) onSelect(found);
      } else if (list.length > 0 && !selectedCalendarId) {
        const primary = list.find((c) => c.primary) || list[0];
        if (primary) onSelect(primary);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to load calendars');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateCalendar = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCalendarName.trim()) {
      setCreateError('Please enter a calendar name');
      return;
    }

    setCreating(true);
    setCreateError(null);
    try {
      const { calendar: newCal } = await api.createCalendar({
        summary: newCalendarName.trim(),
        description: newCalendarDesc.trim() || undefined,
      });

      setSuccessMsg(`Created calendar "${newCal.summary}"!`);
      setNewCalendarName('');
      setNewCalendarDesc('');
      setShowCreateModal(false);

      // Add to list and select immediately
      setCalendars((prev) => [newCal, ...prev]);
      onSelect(newCal);

      setTimeout(() => setSuccessMsg(null), 4000);
    } catch (err: any) {
      setCreateError(err.message || 'Failed to create calendar');
    } finally {
      setCreating(false);
    }
  };

  const filtered = calendars.filter(
    (c) =>
      c.summary.toLowerCase().includes(search.toLowerCase()) ||
      (c.description && c.description.toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <div className="selector-card">
      <div className="selector-header">
        <div className="selector-title-group">
          <h3>📅 Google Calendar</h3>
        </div>
        <div className="selector-header-actions">
          <button
            type="button"
            className="btn btn-primary btn-xs"
            onClick={() => {
              setShowCreateModal((prev) => !prev);
              setCreateError(null);
            }}
            disabled={disabled || loading}
            title="Create a new Google Calendar"
          >
            {showCreateModal ? '✕ Cancel' : '➕ New Calendar'}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            onClick={() => loadCalendars()}
            disabled={loading}
            title="Refresh calendars list"
          >
            {loading ? '↻' : '↻ Refresh'}
          </button>
        </div>
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {successMsg && <div className="alert alert-success">{successMsg}</div>}

      {/* Inline Create Calendar Panel */}
      {showCreateModal && (
        <form onSubmit={handleCreateCalendar} className="create-calendar-box">
          <div className="create-calendar-header">
            <h4>✨ Create New Google Calendar</h4>
            <span className="create-calendar-hint">A new calendar will be added to your Google account</span>
          </div>

          {createError && <div className="alert alert-error alert-sm">{createError}</div>}

          <div className="create-calendar-inputs">
            <div className="input-group">
              <label htmlFor="new-cal-name">Calendar Name *</label>
              <input
                id="new-cal-name"
                type="text"
                placeholder="e.g. Smartsheet Sync, Project Milestones"
                value={newCalendarName}
                onChange={(e) => setNewCalendarName(e.target.value)}
                disabled={creating}
                autoFocus
              />
            </div>
            <div className="input-group">
              <label htmlFor="new-cal-desc">Description (optional)</label>
              <input
                id="new-cal-desc"
                type="text"
                placeholder="e.g. Synced automatically from Smartsheet"
                value={newCalendarDesc}
                onChange={(e) => setNewCalendarDesc(e.target.value)}
                disabled={creating}
              />
            </div>
          </div>

          <div className="create-calendar-footer">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setShowCreateModal(false)}
              disabled={creating}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-accent btn-sm"
              disabled={creating || !newCalendarName.trim()}
            >
              {creating ? 'Creating...' : '✓ Create & Select Calendar'}
            </button>
          </div>
        </form>
      )}

      <div className="selector-search">
        <input
          type="text"
          placeholder="Search calendars..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          disabled={disabled || loading}
        />
      </div>

      <div className="selector-list">
        {loading ? (
          <div className="selector-loading">
            <div className="spinner" />
            Loading calendars...
          </div>
        ) : filtered.length === 0 ? (
          <div className="selector-empty">
            {search ? 'No matching calendars found' : 'No calendars found'}
          </div>
        ) : (
          filtered.map((cal) => {
            const isSelected = selectedCalendarId === cal.id;
            return (
              <button
                key={cal.id}
                type="button"
                className={'selector-item ' + (isSelected ? 'selected' : '')}
                onClick={() => onSelect(cal)}
                disabled={disabled}
              >
                <span
                  className="calendar-color-dot"
                  style={{ backgroundColor: cal.backgroundColor || '#4285f4' }}
                />
                <span className="selector-item-name">
                  <span>{cal.summary}</span>
                  {cal.primary && <span className="badge-primary">Primary</span>}
                  {cal.accessRole === 'owner' && !cal.primary && (
                    <span className="badge-subtle">Owner</span>
                  )}
                </span>
                {isSelected && <span className="selector-check">✓</span>}
              </button>
            );
          })
        )}
      </div>

      <div className="calendar-dedup-hint">
        <span className="dedup-icon">🛡️</span>
        <span>
          <strong>Zero Duplicate Guarantee:</strong> When syncing to an existing calendar, pre-existing events are matched and linked without creating duplicates.
        </span>
      </div>
    </div>
  );
}
