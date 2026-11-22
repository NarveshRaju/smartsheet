import { useState } from 'react';
import SheetSelector from './SheetSelector.js';
import CalendarSelector from './CalendarSelector.js';
import ColumnMapping from './ColumnMapping.js';
import { api } from '../api/client.js';
import type { Sheet, Calendar, ColumnMapping as CMType, SyncConfig } from '../types/index.js';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onCreated: (config: SyncConfig) => void;
}

export default function NewConnectionModal({ isOpen, onClose, onCreated }: Props) {
  const [name, setName] = useState('');
  const [selectedSheetId, setSelectedSheetId] = useState('');
  const [selectedSheetName, setSelectedSheetName] = useState('');
  const [selectedCalendarId, setSelectedCalendarId] = useState('');
  const [selectedCalendarName, setSelectedCalendarName] = useState('');
  const [columnMapping, setColumnMapping] = useState<CMType>({});
  const [isEnabled, setIsEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSheetSelect = (s: Sheet) => {
    setSelectedSheetId(s.id);
    setSelectedSheetName(s.name);
    setColumnMapping({});
    if (!name.trim()) {
      setName(s.name);
    }
  };

  const handleCalSelect = (c: Calendar) => {
    setSelectedCalendarId(c.id);
    setSelectedCalendarName(c.summary);
  };

  const hasSheet = Boolean(selectedSheetId);
  const hasCalendar = Boolean(selectedCalendarId);
  const hasTitle = Boolean(columnMapping.title);
  const hasStartDate = Boolean(columnMapping.startDate);
  const canSave = hasSheet && hasCalendar && hasTitle && hasStartDate;

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setError(null);

    try {
      const payload = {
        name: name.trim() || `${selectedSheetName} ➔ ${selectedCalendarName}`,
        smartsheetSheetId: selectedSheetId,
        sheetName: selectedSheetName,
        googleCalendarId: selectedCalendarId,
        calendarName: selectedCalendarName,
        columnMapping,
        isEnabled,
      };

      const { config } = await api.createConnection(payload);
      onCreated(config);
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to create connection');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-backdrop" onClick={onClose} />
      <div className="modal-dialog modal-lg">
        <div className="modal-header">
          <div className="modal-title-group">
            <span className="modal-icon">➕</span>
            <div>
              <h3>Link New Project / Connection</h3>
              <p className="modal-subtitle">
                Connect a Smartsheet project to a Google Calendar with continuous one-way synchronization
              </p>
            </div>
          </div>
          <button className="modal-close-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        <form onSubmit={handleSave}>
          <div className="modal-body">
            {error && <div className="alert alert-error">{error}</div>}

            {/* Project / Connection Name */}
            <div className="form-group" style={{ marginBottom: '1.25rem' }}>
              <label className="form-label" htmlFor="conn-name">
                Connection / Project Label
              </label>
              <input
                id="conn-name"
                type="text"
                className="form-input"
                placeholder="e.g., Marketing Q4 Schedule, Sprint 23 Roadmap..."
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <span className="form-hint">
                Give this link a recognizable name to easily manage it among your projects.
              </span>
            </div>

            {/* Select Sheet & Calendar */}
            <div className="config-grid" style={{ marginBottom: '1.5rem' }}>
              <SheetSelector selectedSheetId={selectedSheetId} onSelect={handleSheetSelect} />
              <CalendarSelector selectedCalendarId={selectedCalendarId} onSelect={handleCalSelect} />
            </div>

            {/* Column Mapping */}
            <ColumnMapping
              sheetId={selectedSheetId}
              mapping={columnMapping}
              onChange={setColumnMapping}
            />

            {/* Auto-Sync Toggle */}
            <div className="connection-enable-option">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={isEnabled}
                  onChange={(e) => setIsEnabled(e.target.checked)}
                />
                <div>
                  <strong>Enable Instant & Background Auto-Sync</strong>
                  <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', margin: 0 }}>
                    Automatically syncs via Smartsheet webhooks when rows change and checks periodically.
                  </p>
                </div>
              </label>
            </div>

            {/* Validation Checklist */}
            <div className="validation-checklist" style={{ marginTop: '1rem' }}>
              <span className={'check-badge ' + (hasSheet ? 'valid' : 'invalid')}>
                {hasSheet ? `✓ Sheet: ${selectedSheetName}` : '✗ Select a Smartsheet'}
              </span>
              <span className={'check-badge ' + (hasCalendar ? 'valid' : 'invalid')}>
                {hasCalendar ? `✓ Calendar: ${selectedCalendarName}` : '✗ Select a Google Calendar'}
              </span>
              <span className={'check-badge ' + (hasTitle ? 'valid' : 'invalid')}>
                {hasTitle ? '✓ Event Title Mapped' : '✗ Map Event Title'}
              </span>
              <span className={'check-badge ' + (hasStartDate ? 'valid' : 'invalid')}>
                {hasStartDate ? '✓ Start Date Mapped' : '✗ Map Start Date'}
              </span>
            </div>
          </div>

          <div className="modal-footer">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary btn-lg"
              disabled={saving || !canSave}
            >
              {saving ? 'Creating Connection…' : 'Link Connection & Sync'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
