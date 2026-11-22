import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../api/client.js';
import type { LogEntry, SyncConfig } from '../types/index.js';

interface Props {
  configs?: SyncConfig[];
  initialConfigId?: string;
}

export default function LogViewer({ configs = [], initialConfigId = '' }: Props) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [levelFilter, setLevelFilter] = useState<'all' | 'info' | 'warn' | 'error'>('all');
  const [selectedConfigId, setSelectedConfigId] = useState<string>(initialConfigId);
  const [searchQuery, setSearchQuery] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date>(new Date());
  const [totalCount, setTotalCount] = useState(0);
  const terminalRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const fetchLogs = useCallback(async () => {
    try {
      const data = await api.getLogs({
        limit: 300,
        level: levelFilter === 'all' ? undefined : levelFilter,
        search: searchQuery.trim() || undefined,
        configId: selectedConfigId || undefined,
      });
      setLogs(data.logs || []);
      setTotalCount(data.total || 0);
      setLastRefreshedAt(new Date());
    } catch (err) {
      console.error('Failed to fetch logs:', err);
    } finally {
      setLoading(false);
    }
  }, [levelFilter, selectedConfigId, searchQuery]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => {
      fetchLogs();
    }, 3000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchLogs]);

  useEffect(() => {
    if (autoScroll && terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const handleClear = async () => {
    if (!confirm('Are you sure you want to clear the system log view?')) return;
    try {
      await api.clearLogs();
      setLogs([]);
      setTotalCount(0);
    } catch (err: any) {
      alert('Failed to clear logs: ' + err.message);
    }
  };

  const handleDownload = () => {
    const content = logs.map((l) => l.raw).join('\n');
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `smartsheet-sync-logs-${new Date().toISOString().slice(0, 10)}.log`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const infoCount = logs.filter((l) => l.level === 'info').length;
  const warnCount = logs.filter((l) => l.level === 'warn').length;
  const errorCount = logs.filter((l) => l.level === 'error').length;

  return (
    <div className="log-viewer-container">
      {/* ── Toolbar ────────────────────────────────────────── */}
      <div className="log-toolbar">
        <div className="log-filters-left">
          {/* Level Filter Buttons */}
          <div className="log-level-pills">
            {(['all', 'info', 'warn', 'error'] as const).map((lvl) => (
              <button
                key={lvl}
                className={`log-pill ${levelFilter === lvl ? 'active' : ''} pill-${lvl}`}
                onClick={() => setLevelFilter(lvl)}
              >
                {lvl.toUpperCase()}
                {lvl === 'all' && ` (${logs.length})`}
                {lvl === 'info' && ` (${infoCount})`}
                {lvl === 'warn' && ` (${warnCount})`}
                {lvl === 'error' && ` (${errorCount})`}
              </button>
            ))}
          </div>

          {/* Project / Config Filter */}
          {configs.length > 0 && (
            <div className="log-select-wrapper">
              <select
                className="log-select"
                value={selectedConfigId}
                onChange={(e) => setSelectedConfigId(e.target.value)}
              >
                <option value="">All Projects & Workflows</option>
                {configs.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name || `${c.sheetName || 'Sheet'} ➔ ${c.calendarName || 'Calendar'}`}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Search Box */}
          <div className="log-search-wrapper">
            <svg
              className="log-search-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              width="14"
              height="14"
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              className="log-search-input"
              placeholder="Search logs (row IDs, webhooks, errors)..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button className="log-search-clear" onClick={() => setSearchQuery('')}>
                ×
              </button>
            )}
          </div>
        </div>

        <div className="log-actions-right">
          {/* Auto Refresh Toggle */}
          <label className="log-auto-refresh-label" title="Live stream logs automatically every 3s">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            <span className={`live-pulse-dot ${autoRefresh ? 'active' : ''}`} />
            <span>Live Feed</span>
          </label>

          {/* Auto Scroll Toggle */}
          <button
            className={`btn btn-xs ${autoScroll ? 'btn-ghost' : 'btn-ghost'}`}
            style={{ opacity: autoScroll ? 1 : 0.6 }}
            onClick={() => setAutoScroll(!autoScroll)}
            title="Auto-scroll to latest"
          >
            {autoScroll ? '⬇ Sticky' : '⏸ Free'}
          </button>

          {/* Refresh Button */}
          <button
            className="btn btn-ghost btn-sm"
            onClick={fetchLogs}
            disabled={loading}
            title="Manual refresh"
          >
            ↻ Refresh
          </button>

          {/* Download Logs */}
          <button
            className="btn btn-ghost btn-sm"
            onClick={handleDownload}
            disabled={logs.length === 0}
            title="Download logs to a text file"
          >
            ⤓ Export
          </button>

          {/* Clear Logs */}
          <button
            className="btn btn-ghost btn-sm btn-clear-logs"
            onClick={handleClear}
            disabled={logs.length === 0}
            title="Clear buffer"
          >
            🗑 Clear
          </button>
        </div>
      </div>

      {/* ── Status Bar ─────────────────────────────────────── */}
      <div className="log-status-bar">
        <span>
          Showing <strong>{logs.length}</strong> of <strong>{totalCount}</strong> captured events
        </span>
        <span className="log-timestamp-label">
          Updated: {lastRefreshedAt.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })}
        </span>
      </div>

      {/* ── Terminal Console Display ───────────────────────── */}
      <div className="log-terminal" ref={terminalRef}>
        {loading && logs.length === 0 ? (
          <div className="log-empty-terminal">
            <div className="spinner spinner-sm" />
            <p>Loading activity logs...</p>
          </div>
        ) : logs.length === 0 ? (
          <div className="log-empty-terminal">
            <p>No log records found matching your filters.</p>
            {searchQuery && (
              <button className="btn btn-ghost btn-xs" onClick={() => setSearchQuery('')}>
                Clear search filter
              </button>
            )}
          </div>
        ) : (
          <div className="log-lines-list">
            {logs.map((log) => (
              <div key={log.id} className={`log-line log-line-${log.level}`}>
                <span className="log-time">{log.timestamp}</span>
                <span className={`log-badge log-badge-${log.level}`}>
                  {log.level.toUpperCase()}
                </span>
                <span className="log-text">{log.message}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
