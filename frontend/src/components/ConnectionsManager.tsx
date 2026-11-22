import { useState } from 'react';
import { api } from '../api/client.js';
import type { SyncConfig } from '../types/index.js';

interface Props {
  configs: SyncConfig[];
  onOpenNewModal: () => void;
  onSelectConfig: (config: SyncConfig) => void;
  onRefresh: () => void;
  onViewLogs: (configId: string) => void;
  onUpdated: (config: SyncConfig) => void;
  onDeleted: (configId: string) => void;
}

export default function ConnectionsManager({
  configs,
  onOpenNewModal,
  onSelectConfig,
  onRefresh,
  onViewLogs,
  onUpdated,
  onDeleted,
}: Props) {
  const [syncingMap, setSyncingMap] = useState<Record<string, boolean>>({});
  const [syncingAll, setSyncingAll] = useState(false);
  const [syncProgressMap, setSyncProgressMap] = useState<Record<string, string>>({});
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Compute aggregate stats across all connections
  const totalProjects = configs.length;
  const activeCount = configs.filter((c) => c.isEnabled).length;
  const totalSynced = configs.reduce((acc, c) => acc + (c.stats?.synced || 0), 0);
  const totalFailed = configs.reduce((acc, c) => acc + (c.stats?.failed || 0), 0);

  const handleToggleAutoSync = async (e: React.MouseEvent, config: SyncConfig) => {
    e.stopPropagation();
    try {
      const nextEnabled = !config.isEnabled;
      const { config: updated } = await api.updateConnection(config.id, { isEnabled: nextEnabled });
      onUpdated(updated);
    } catch (err: any) {
      alert('Failed to update sync status: ' + err.message);
    }
  };

  const handleQuickSync = async (e: React.MouseEvent, config: SyncConfig) => {
    e.stopPropagation();
    setSyncingMap((prev) => ({ ...prev, [config.id]: true }));
    setSyncProgressMap((prev) => ({ ...prev, [config.id]: 'Starting…' }));
    try {
      await api.syncConnection(config.id, (msg) => {
        setSyncProgressMap((prev) => ({ ...prev, [config.id]: msg }));
      });
      onRefresh();
    } catch (err: any) {
      alert(`Sync failed for ${config.name || config.sheetName}: ` + err.message);
    } finally {
      setSyncingMap((prev) => ({ ...prev, [config.id]: false }));
      setSyncProgressMap((prev) => ({ ...prev, [config.id]: '' }));
    }
  };

  const handleSyncAll = async () => {
    setSyncingAll(true);
    try {
      const res = await api.syncAllConnections();
      alert(`Triggered background sync for ${res.count} active project connection(s)!`);
      setTimeout(onRefresh, 3000);
    } catch (err: any) {
      alert('Failed to trigger bulk sync: ' + err.message);
    } finally {
      setSyncingAll(false);
    }
  };

  const handleDelete = async (e: React.MouseEvent, config: SyncConfig) => {
    e.stopPropagation();
    const name = config.name || `${config.sheetName} ➔ ${config.calendarName}`;
    if (!confirm(`Are you sure you want to unlink and remove connection "${name}"?\nCalendar events will be kept.`)) {
      return;
    }
    setDeletingId(config.id);
    try {
      await api.deleteConnection(config.id);
      onDeleted(config.id);
    } catch (err: any) {
      alert('Failed to delete connection: ' + err.message);
    } finally {
      setDeletingId(null);
    }
  };

  const formatDate = (isoStr?: string) => {
    if (!isoStr) return 'Never synced';
    const date = new Date(isoStr);
    return date.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  };

  return (
    <div className="connections-manager">
      {/* ── Aggregate Metric Cards ───────────────────────── */}
      <div className="connections-metrics-grid">
        <div className="metric-card">
          <div className="metric-header">
            <span className="metric-title">Linked Projects</span>
            <span className="metric-icon">📁</span>
          </div>
          <div className="metric-value">{totalProjects}</div>
          <div className="metric-caption">Smartsheet ↔ Google Calendar connections</div>
        </div>

        <div className="metric-card">
          <div className="metric-header">
            <span className="metric-title">Auto-Sync Active</span>
            <span className="metric-icon">⚡</span>
          </div>
          <div className="metric-value text-emerald">{activeCount}</div>
          <div className="metric-caption">Live webhook & continuous sync active</div>
        </div>

        <div className="metric-card">
          <div className="metric-header">
            <span className="metric-title">Events Synced</span>
            <span className="metric-icon">✓</span>
          </div>
          <div className="metric-value text-blue">{totalSynced}</div>
          <div className="metric-caption">Calendar events verified & aligned</div>
        </div>

        <div className="metric-card">
          <div className="metric-header">
            <span className="metric-title">Issues / Attention</span>
            <span className="metric-icon">⚠️</span>
          </div>
          <div className={`metric-value ${totalFailed > 0 ? 'text-rose' : 'text-muted'}`}>
            {totalFailed}
          </div>
          <div className="metric-caption">
            {totalFailed > 0 ? 'Rows requiring review or retry' : 'All connections running smoothly'}
          </div>
        </div>
      </div>

      {/* ── Action Bar ───────────────────────────────────── */}
      <div className="connections-action-bar">
        <div className="action-bar-left">
          <h3 className="section-subtitle">Your Active Connections ({configs.length})</h3>
        </div>
        <div className="action-bar-right">
          <button
            className="btn btn-ghost btn-sm"
            onClick={onRefresh}
            title="Refresh connection status"
          >
            ↻ Refresh
          </button>
          <button
            className="btn btn-accent btn-sm"
            onClick={handleSyncAll}
            disabled={syncingAll || activeCount === 0}
            title="Trigger sync for all enabled connections"
          >
            {syncingAll ? 'Triggering…' : '⚡ Sync All Active'}
          </button>
          <button className="btn btn-primary btn-sm" onClick={onOpenNewModal}>
            ➕ Link New Project
          </button>
        </div>
      </div>

      {/* ── Empty State ──────────────────────────────────── */}
      {configs.length === 0 ? (
        <div className="empty-connections-card">
          <div className="empty-icon">🔗</div>
          <h3>No Projects Linked Yet</h3>
          <p>
            Connect multiple Smartsheet sheets to individual Google Calendars to automate event
            schedules across your entire organization.
          </p>
          <button className="btn btn-primary btn-lg" onClick={onOpenNewModal}>
            ➕ Link Your First Project
          </button>
        </div>
      ) : (
        /* ── Connections Grid ────────────────────────────── */
        <div className="project-cards-grid">
          {configs.map((config) => {
            const isSyncing = syncingMap[config.id];
            const progress = syncProgressMap[config.id];
            const stats = config.stats;
            const pct =
              stats && stats.total > 0 ? Math.round((stats.synced / stats.total) * 100) : 0;
            const hasErrors = stats && stats.failed > 0;

            return (
              <div
                key={config.id}
                className={`project-card ${config.isEnabled ? 'active' : 'paused'} ${hasErrors ? 'has-issues' : ''}`}
                onClick={() => onSelectConfig(config)}
              >
                {/* Card Header */}
                <div className="project-card-header">
                  <div className="project-title-wrapper">
                    <span className="project-folder-icon">📊</span>
                    <h4 className="project-name">
                      {config.name || `${config.sheetName || 'Sheet'} ➔ ${config.calendarName || 'Calendar'}`}
                    </h4>
                  </div>
                  <div className="project-badges">
                    <span className={`status-pill ${config.isEnabled ? 'pill-active' : 'pill-paused'}`}>
                      <span className="pill-dot" />
                      {config.isEnabled ? 'Active' : 'Paused'}
                    </span>
                    {hasErrors && (
                      <span className="status-pill pill-error" title={`${stats.failed} failed rows`}>
                        ⚠️ {stats.failed} Issues
                      </span>
                    )}
                  </div>
                </div>

                {/* Connection Links */}
                <div className="project-card-links">
                  <div className="link-item">
                    <span className="link-label">Smartsheet:</span>
                    <span className="link-val" title={config.sheetName || config.smartsheetSheetId}>
                      📋 {config.sheetName || config.smartsheetSheetId}
                    </span>
                  </div>
                  <div className="link-item">
                    <span className="link-label">Google Calendar:</span>
                    <span className="link-val" title={config.calendarName || config.googleCalendarId}>
                      📅 {config.calendarName || config.googleCalendarId}
                    </span>
                  </div>
                </div>

                {/* Progress / Stats */}
                <div className="project-card-stats">
                  <div className="progress-bar-wrapper">
                    <div className="progress-bar">
                      <div
                        className={`progress-fill ${hasErrors ? 'progress-fill-warning' : ''}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="progress-pct">{pct}%</span>
                  </div>
                  <div className="stats-mini-counts">
                    <span>
                      Synced: <strong>{stats?.synced ?? '—'}</strong> / {stats?.total ?? '—'}
                    </span>
                    {hasErrors && (
                      <span className="text-rose">
                        Failed: <strong>{stats?.failed}</strong>
                      </span>
                    )}
                  </div>
                </div>

                {/* Last Sync */}
                <div className="project-card-last-sync">
                  <span>Last Sync: {formatDate(config.lastFullSyncAt)}</span>
                </div>

                {isSyncing && (
                  <div className="card-syncing-indicator">
                    <div className="spinner spinner-xs" />
                    <span>{progress || 'Syncing…'}</span>
                  </div>
                )}

                {/* Card Actions Footer */}
                <div className="project-card-footer" onClick={(e) => e.stopPropagation()}>
                  <div className="footer-left">
                    {/* Auto Sync Toggle */}
                    <label className="card-toggle-label" title="Toggle Auto-Sync">
                      <div
                        className={`toggle-switch toggle-switch-sm ${config.isEnabled ? 'active' : ''}`}
                        onClick={(e) => handleToggleAutoSync(e, config)}
                      >
                        <div className="toggle-thumb" />
                      </div>
                      <span className="toggle-text">
                        {config.isEnabled ? 'Auto-Sync' : 'Paused'}
                      </span>
                    </label>
                  </div>

                  <div className="footer-right">
                    <button
                      className="btn btn-ghost btn-xs"
                      onClick={(e) => handleQuickSync(e, config)}
                      disabled={isSyncing}
                      title="Run sync right now"
                    >
                      {isSyncing ? '⏳ Syncing' : '⚡ Sync'}
                    </button>
                    <button
                      className="btn btn-ghost btn-xs"
                      onClick={() => onViewLogs(config.id)}
                      title="Inspect logs for this project"
                    >
                      📜 Logs
                    </button>
                    <button
                      className="btn btn-primary btn-xs"
                      onClick={() => onSelectConfig(config)}
                      title="Edit settings and column mapping"
                    >
                      ⚙️ Manage
                    </button>
                    <button
                      className="btn btn-ghost btn-xs btn-delete-card"
                      onClick={(e) => handleDelete(e, config)}
                      disabled={deletingId === config.id}
                      title="Unlink connection"
                    >
                      🗑
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
