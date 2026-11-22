import { useState, useEffect, useCallback } from 'react';
import ColumnMapping from './ColumnMapping.js';
import SyncStats from './SyncStats.js';
import ErrorList from './ErrorList.js';
import LogViewer from './LogViewer.js';
import { api } from '../api/client.js';
import type { SyncConfig, SyncStatus, ColumnMapping as CMType, SyncResult } from '../types/index.js';

interface Props {
  config: SyncConfig | null;
  isOpen: boolean;
  onClose: () => void;
  onUpdated: (config: SyncConfig) => void;
  onDeleted: (configId: string) => void;
}

export default function ConnectionDetailModal({
  config,
  isOpen,
  onClose,
  onUpdated,
  onDeleted,
}: Props) {
  const [activeTab, setActiveTab] = useState<'overview' | 'mapping' | 'errors' | 'logs'>('overview');
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState('');
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  // Editable fields
  const [name, setName] = useState('');
  const [columnMapping, setColumnMapping] = useState<CMType>({});
  const [savingMapping, setSavingMapping] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const loadStatus = useCallback(async () => {
    if (!config) return;
    setLoadingStatus(true);
    try {
      const data = await api.getConnectionStatus(config.id);
      setStatus(data);
    } catch (err) {
      console.error('Failed to load connection status:', err);
    } finally {
      setLoadingStatus(false);
    }
  }, [config]);

  useEffect(() => {
    if (config) {
      setName(config.name || `${config.sheetName || 'Sheet'} ➔ ${config.calendarName || 'Calendar'}`);
      setColumnMapping(config.columnMapping || {});
      setSyncResult(null);
      setSyncError(null);
      setSaveMessage(null);
      loadStatus();
    }
  }, [config, loadStatus]);

  if (!isOpen || !config) return null;

  const handleToggleAutoSync = async () => {
    try {
      const nextEnabled = !config.isEnabled;
      const { config: updated } = await api.updateConnection(config.id, { isEnabled: nextEnabled });
      onUpdated(updated);
      loadStatus();
    } catch (err: any) {
      alert('Failed to update sync status: ' + err.message);
    }
  };

  const handleFullSync = async () => {
    setSyncing(true);
    setSyncResult(null);
    setSyncError(null);
    try {
      const { result } = await api.syncConnection(config.id, setSyncProgress);
      setSyncResult(result);
      loadStatus();
      // Also update the config's lastFullSyncAt
      onUpdated({ ...config, lastFullSyncAt: new Date().toISOString() });
    } catch (err: any) {
      setSyncError(err.message || 'Sync failed');
    } finally {
      setSyncing(false);
    }
  };

  const handleSaveMappingAndName = async () => {
    setSavingMapping(true);
    setSaveMessage(null);
    try {
      const { config: updated } = await api.updateConnection(config.id, {
        name: name.trim() || undefined,
        columnMapping,
      });
      onUpdated(updated);
      setSaveMessage('Saved successfully!');
      setTimeout(() => setSaveMessage(null), 3000);
      loadStatus();
    } catch (err: any) {
      setSaveMessage('Error: ' + err.message);
    } finally {
      setSavingMapping(false);
    }
  };

  const handleDelete = async () => {
    const confirmText = prompt(
      `Are you sure you want to remove this connection?\nAll sync records will be deleted (events on Google Calendar will be preserved).\n\nType "DELETE" to confirm:`
    );
    if (confirmText !== 'DELETE') return;

    setDeleting(true);
    try {
      await api.deleteConnection(config.id);
      onDeleted(config.id);
      onClose();
    } catch (err: any) {
      alert('Failed to delete connection: ' + err.message);
    } finally {
      setDeleting(false);
    }
  };

  const failedCount = status?.stats?.failed || status?.failedRecords.length || 0;

  return (
    <div className="modal-overlay">
      <div className="modal-backdrop" onClick={onClose} />
      <div className="modal-dialog modal-xl">
        <div className="modal-header">
          <div className="modal-title-group">
            <span className="modal-icon">⚙️</span>
            <div>
              <h3>{name || 'Connection Details'}</h3>
              <p className="modal-subtitle">
                Sheet: <strong>{config.sheetName || config.smartsheetSheetId}</strong> ➔ Calendar:{' '}
                <strong>{config.calendarName || config.googleCalendarId}</strong>
              </p>
            </div>
          </div>
          <button className="modal-close-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        {/* Modal Navigation Tabs */}
        <div className="modal-tabs">
          <button
            className={`modal-tab-btn ${activeTab === 'overview' ? 'active' : ''}`}
            onClick={() => setActiveTab('overview')}
          >
            📊 Sync & Status
          </button>
          <button
            className={`modal-tab-btn ${activeTab === 'mapping' ? 'active' : ''}`}
            onClick={() => setActiveTab('mapping')}
          >
            🔀 Column Mapping
          </button>
          <button
            className={`modal-tab-btn ${activeTab === 'errors' ? 'active' : ''}`}
            onClick={() => setActiveTab('errors')}
          >
            ⚠️ Issues {failedCount > 0 && <span className="tab-badge error">{failedCount}</span>}
          </button>
          <button
            className={`modal-tab-btn ${activeTab === 'logs' ? 'active' : ''}`}
            onClick={() => setActiveTab('logs')}
          >
            📜 Project Logs
          </button>
        </div>

        <div className="modal-body">
          {/* ── Tab 1: Overview & Controls ───────────────────── */}
          {activeTab === 'overview' && (
            <div className="connection-overview-tab">
              {/* Sync Actions Banner */}
              <div className="connection-quick-banner">
                <div className="quick-banner-left">
                  <label className="toggle-label" style={{ cursor: 'pointer' }}>
                    <div
                      className={'toggle-switch ' + (config.isEnabled ? 'active' : '')}
                      onClick={handleToggleAutoSync}
                    >
                      <div className="toggle-thumb" />
                    </div>
                    <div>
                      <strong>
                        {config.isEnabled ? 'Automatic Sync Active' : 'Automatic Sync Paused'}
                      </strong>
                      <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                        {config.isEnabled
                          ? 'Listening to Smartsheet webhooks and running auto-sync intervals'
                          : 'Events will not sync until triggered manually or re-enabled'}
                      </p>
                    </div>
                  </label>
                </div>

                <div className="quick-banner-right">
                  <button
                    className="btn btn-accent btn-lg"
                    onClick={handleFullSync}
                    disabled={syncing}
                  >
                    {syncing ? (
                      <>
                        <div className="spinner spinner-sm spinner-white" />
                        Syncing…
                      </>
                    ) : (
                      <>⚡ Run Full Sync</>
                    )}
                  </button>
                </div>
              </div>

              {syncing && (
                <div className="sync-progress-box">
                  <div className="spinner spinner-sm" />
                  <p>{syncProgress || 'Processing sync…'}</p>
                </div>
              )}

              {syncError && <div className="alert alert-error"><strong>Sync Failed:</strong> {syncError}</div>}

              {syncResult && (
                <div className="sync-result" style={{ marginTop: '1rem' }}>
                  <h4>Sync Completed</h4>
                  <div className="sync-result-grid">
                    <div className="result-item result-created">
                      <span className="result-count">{syncResult.created}</span>
                      <span className="result-label">Created</span>
                    </div>
                    <div className="result-item result-updated">
                      <span className="result-count">{syncResult.updated}</span>
                      <span className="result-label">Updated</span>
                    </div>
                    <div className="result-item result-deleted">
                      <span className="result-count">{syncResult.deleted}</span>
                      <span className="result-label">Deleted</span>
                    </div>
                    <div className="result-item result-failed">
                      <span className="result-count">{syncResult.failed}</span>
                      <span className="result-label">Failed</span>
                    </div>
                  </div>
                </div>
              )}

              {/* Statistics */}
              <div style={{ marginTop: '1.5rem' }}>
                <SyncStats
                  stats={status?.stats || null}
                  lastFullSyncAt={status?.config?.lastFullSyncAt || config.lastFullSyncAt}
                />
              </div>
            </div>
          )}

          {/* ── Tab 2: Edit Mapping ──────────────────────────── */}
          {activeTab === 'mapping' && (
            <div className="connection-mapping-tab">
              <div className="form-group" style={{ marginBottom: '1.5rem' }}>
                <label className="form-label">Connection / Project Name</label>
                <input
                  type="text"
                  className="form-input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g., Marketing Releases 2026"
                />
              </div>

              <ColumnMapping
                sheetId={config.smartsheetSheetId}
                mapping={columnMapping}
                onChange={setColumnMapping}
              />

              <div className="config-actions" style={{ marginTop: '1.5rem' }}>
                <button
                  className="btn btn-primary btn-lg"
                  onClick={handleSaveMappingAndName}
                  disabled={savingMapping}
                >
                  {savingMapping ? 'Saving…' : 'Save Configuration Changes'}
                </button>
                {saveMessage && (
                  <span
                    className={
                      'save-message ' + (saveMessage.startsWith('Error') ? 'error' : 'success')
                    }
                  >
                    {saveMessage}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* ── Tab 3: Errors / Issues ───────────────────────── */}
          {activeTab === 'errors' && (
            <div className="connection-errors-tab">
              <ErrorList
                records={status?.failedRecords || []}
                onRetryComplete={() => {
                  loadStatus();
                }}
              />
            </div>
          )}

          {/* ── Tab 4: Project Logs ──────────────────────────── */}
          {activeTab === 'logs' && (
            <div className="connection-logs-tab">
              <LogViewer configs={[config]} initialConfigId={config.id} />
            </div>
          )}
        </div>

        <div className="modal-footer" style={{ justifyContent: 'space-between' }}>
          <button
            type="button"
            className="btn btn-outline-danger btn-sm"
            onClick={handleDelete}
            disabled={deleting}
          >
            {deleting ? 'Removing…' : '🗑 Unlink & Delete Connection'}
          </button>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
