import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ClipboardEvent, KeyboardEvent, MouseEvent, WheelEvent } from 'react';
import {
  getGetTrafficSessionStateQueryKey,
  useEndTrafficSession,
  useGetTrafficSessionState,
  useInteractWithTrafficSession,
  useSetTrafficSessionRecording,
  useStartTrafficSession,
} from '@workspace/api-client-react';
import type { TrafficRequest, TrafficRequestType, TrafficSessionState } from '@workspace/api-client-react';
import { Activity, ArrowDownToLine, ArrowUpRight, Check, CircleStop, Clock3, Globe2, MousePointer2, Pause, Play, Search, ShieldCheck, X } from 'lucide-react';
import './interactive-capture.css';

type Filter = 'all' | 'api-candidate' | TrafficRequestType;

const filters: { label: string; value: Filter }[] = [
  { label: 'Alle', value: 'all' },
  { label: 'API-Kandidaten', value: 'api-candidate' },
  { label: 'Fetch / XHR', value: 'fetch-xhr' },
  { label: 'REST', value: 'rest' },
  { label: 'GraphQL', value: 'graphql' },
  { label: 'WebSocket', value: 'websocket' },
];

const quickTerms = ['price', 'player', 'games', 'listing', 'sales', 'market'];

function formatDuration(ms: number | null | undefined) {
  if (ms == null) return '—';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date);
}

function requestTypeLabel(type: TrafficRequestType) {
  return type === 'fetch-xhr' ? 'Fetch / XHR' : type === 'websocket' ? 'WebSocket' : type.toUpperCase();
}

function isApiCandidate(request: TrafficRequest) {
  if (request.type === 'rest' || request.type === 'graphql' || request.type === 'websocket') return true;
  if (request.resourceType !== 'fetch' && request.resourceType !== 'xhr') return false;
  return /(?:^|\/)(?:api|ajax|data|graphql|gql|rest|v\d+)(?:\/|$)|price|player|games?|listing|sales?|market|search|stats?/i.test(request.path);
}

function matchesFilter(request: TrafficRequest, filter: Filter) {
  if (filter === 'all') return true;
  if (filter === 'api-candidate') return isApiCandidate(request);
  if (filter === 'fetch-xhr') return request.resourceType === 'fetch' || request.resourceType === 'xhr';
  return request.type === filter;
}

function safeUrl(value: string) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value.split('?')[0];
  }
}

function RequestRow({ request }: { request: TrafficRequest }) {
  const statusClass = request.statusCode == null ? 'unknown' : request.statusCode >= 400 ? 'error' : request.statusCode >= 300 ? 'redirect' : 'ok';
  const candidate = isApiCandidate(request);
  return (
    <tr className={candidate ? 'ic-api-candidate-row' : undefined} data-testid={`capture-request-${request.id}`}>
      <td className="ic-time">{formatTime(request.startedAt)}</td>
      <td>
        <div className="ic-route" title={safeUrl(request.url)}>
          <span className="ic-method">{request.method}</span>
          <span className="ic-route-url">{candidate && <span className="ic-candidate-dot" title="Wahrscheinlicher API-Request">●</span>}{safeUrl(request.url)}</span>
          <span className="ic-host">{request.hostname}</span>
          <span className="ic-path">{request.path}</span>
        </div>
      </td>
      <td><span className={`ic-status ic-status-${statusClass}`}>{request.statusCode ?? '—'}</span></td>
      <td><span className="ic-type">{requestTypeLabel(request.type)}</span></td>
      <td className="ic-content" title={[request.contentType ?? '', ...(request.responseSchema ?? [])].filter(Boolean).join(' · ')}>{request.contentType || '—'}{request.responseSchema?.length ? <small> · Schema: {request.responseSchema.slice(0, 3).join(', ')}{request.responseSchema.length > 3 ? ' …' : ''}</small> : null}</td>
      <td className="ic-duration">{formatDuration(request.durationMs)}</td>
    </tr>
  );
}

export interface InteractiveCaptureProps {
  initialUrl: string;
  onClose: () => void;
}

export function InteractiveCapture({ initialUrl, onClose }: InteractiveCaptureProps) {
  const [sessionId, setSessionId] = useState('');
  const [session, setSession] = useState<TrafficSessionState | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [ended, setEnded] = useState(false);
  const [endError, setEndError] = useState('');
  const [interactionError, setInteractionError] = useState('');
  const [baselineRequestIds, setBaselineRequestIds] = useState<string[]>([]);
  const [onlyNewRequests, setOnlyNewRequests] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(false);
  const sessionIdRef = useRef('');
  const endedRef = useRef(false);
  const interactionQueue = useRef<Promise<unknown>>(Promise.resolve());
  const start = useStartTrafficSession();
  const recording = useSetTrafficSessionRecording();
  const interact = useInteractWithTrafficSession();
  const end = useEndTrafficSession();

  const sessionQuery = useGetTrafficSessionState({ sessionId }, {
    query: {
      enabled: !!sessionId && !ended,
      queryKey: getGetTrafficSessionStateQueryKey({ sessionId }),
      refetchInterval: sessionId && !ended ? 1000 : false,
    },
  });
  const liveSession = sessionQuery.data ?? session;

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    start.mutateAsync({ data: { url: initialUrl, authorized: true } }).then((state: TrafficSessionState) => {
      sessionIdRef.current = state.sessionId;
      if (cancelled || !mountedRef.current) {
        end.mutate({ data: { sessionId: state.sessionId } });
        return;
      }
      setSession(state);
      setSessionId(state.sessionId);
    }).catch(() => {
      if (!cancelled && mountedRef.current) setEndError('Die Browser-Sitzung konnte nicht geöffnet werden. Prüfe die öffentliche URL und deine Berechtigung.');
    });
    return () => {
      cancelled = true;
      mountedRef.current = false;
      const id = sessionIdRef.current;
      if (id && !endedRef.current) {
        endedRef.current = true;
        end.mutate({ data: { sessionId: id } });
      }
    };
  // Session creation is intentionally once per mounted capture.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (sessionQuery.data) setSession(sessionQuery.data);
  }, [sessionQuery.data]);

  const sendInteraction = useCallback((action: 'click' | 'scroll' | 'key', fields: { x?: number; y?: number; deltaX?: number; deltaY?: number; key?: string }) => {
    const id = sessionIdRef.current;
    if (!id || endedRef.current) return;
    interactionQueue.current = interactionQueue.current
      .catch(() => undefined)
      .then(async () => {
        try {
          await interact.mutateAsync({ data: { sessionId: id, action, ...fields } });
          if (mountedRef.current) setInteractionError('');
        } catch {
          if (mountedRef.current) setInteractionError('Die Browser-Interaktion konnte nicht ausgeführt werden.');
        }
      });
  }, [interact.mutateAsync]);

  const handleViewportClick = (event: MouseEvent<HTMLDivElement>) => {
    const image = event.currentTarget.querySelector('img');
    if (!image) return;
    const rect = image.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return;
    const width = liveSession?.viewportWidth || rect.width;
    const height = liveSession?.viewportHeight || rect.height;
    const x = Math.max(0, Math.min(width - 1, Math.round(((event.clientX - rect.left) / rect.width) * width)));
    const y = Math.max(0, Math.min(height - 1, Math.round(((event.clientY - rect.top) / rect.height) * height)));
    sendInteraction('click', { x, y });
    event.currentTarget.focus();
  };

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const factorX = (liveSession?.viewportWidth || event.currentTarget.clientWidth) / event.currentTarget.clientWidth;
    const factorY = (liveSession?.viewportHeight || event.currentTarget.clientHeight) / event.currentTarget.clientHeight;
    sendInteraction('scroll', { deltaX: Math.round(event.deltaX * factorX), deltaY: Math.round(event.deltaY * factorY) });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const clipboardShortcut = (event.metaKey || event.ctrlKey) && ['c', 'v', 'x'].includes(event.key.toLowerCase());
    if (clipboardShortcut) {
      event.preventDefault();
      return;
    }
    if (event.key === 'Control' || event.key === 'Meta' || event.key === 'Alt') {
      event.preventDefault();
      return;
    }
    if (event.altKey || event.metaKey) {
      event.preventDefault();
      return;
    }
    if (event.ctrlKey && !['a', 'f'].includes(event.key.toLowerCase())) {
      event.preventDefault();
      return;
    }
    if (event.key.length > 1 && !['Enter', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Tab', 'Escape', ' '].includes(event.key)) return;
    event.preventDefault();
    const key = event.key === ' ' ? 'Space' : event.key;
    const forwardedKey = event.ctrlKey ? `Control+${key}` : event.shiftKey && key.length === 1 ? `Shift+${key}` : key;
    sendInteraction('key', { key: forwardedKey });
  };

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => event.preventDefault();

  const toggleRecording = () => {
    if (!liveSession || !sessionId) return;
    recording.mutate({ data: { sessionId, recording: !liveSession.recording } }, {
      onSuccess: (state: TrafficSessionState) => setSession(state),
    });
  };

  const endSession = async () => {
    const id = sessionIdRef.current;
    if (!id || endedRef.current) {
      setEnded(true);
      onClose();
      return;
    }
    endedRef.current = true;
    setEndError('');
    try {
      await end.mutateAsync({ data: { sessionId: id } });
      setEnded(true);
      onClose();
    } catch {
      endedRef.current = false;
      setEndError('The session could not be closed. Please try again.');
    }
  };

  const visibleRequests = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    const baseline = new Set(baselineRequestIds);
    return (liveSession?.requests ?? [])
      .filter((request: TrafficRequest) => {
        if (onlyNewRequests && baseline.has(request.id)) return false;
        const matchingType = matchesFilter(request, filter);
        const terms = [request.url, request.hostname, request.path, request.method, request.contentType ?? '', ...(request.responseSchema ?? []), request.resourceType, request.type, String(request.statusCode ?? '')].join(' ').toLocaleLowerCase();
        return matchingType && (!needle || terms.includes(needle));
      })
      .slice()
      .reverse();
  }, [baselineRequestIds, filter, liveSession?.requests, onlyNewRequests, search]);

  const apiCandidateCount = useMemo(
    () => (liveSession?.requests ?? []).filter((request: TrafficRequest) => isApiCandidate(request)).length,
    [liveSession?.requests],
  );

  const markCurrentTraffic = () => {
    setBaselineRequestIds((liveSession?.requests ?? []).map((request: TrafficRequest) => request.id));
    setOnlyNewRequests(true);
  };

  const showAllTraffic = () => {
    setOnlyNewRequests(false);
    setBaselineRequestIds([]);
  };

  const exportJson = () => {
    if (!liveSession) return;
    const { screenshot: _screenshot, sessionId: _sessionId, ...safeState } = liveSession;
    const payload = { ...safeState, exportedAt: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const downloadUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.download = `traffic-live-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(downloadUrl);
  };

  const screenshotSrc = liveSession?.screenshot
    ? liveSession.screenshot.startsWith('data:') ? liveSession.screenshot : `data:image/jpeg;base64,${liveSession.screenshot}`
    : '';
  const isStarting = start.isPending && !liveSession;
  const isClosed = ended || liveSession?.closed;

  return (
    <section className="ic-workbench" aria-label="Interactive traffic capture" data-testid="interactive-capture">
      <header className="ic-header">
        <div className="ic-heading">
          <div className="ic-mark"><Activity size={17} /></div>
          <div>
        <div className="ic-eyebrow">LIVE-SITZUNG <span>·</span> BERECHTIGTE ANALYSE</div>
            <h2>Interaktive Aufzeichnung</h2>
          </div>
        </div>
        <div className="ic-header-actions">
          <div className={`ic-live-pill ${liveSession?.recording ? 'is-recording' : ''}`} data-testid="status-capture-recording">
            <span />{liveSession?.recording ? 'Aufzeichnung läuft' : isClosed ? 'Sitzung beendet' : 'Pausiert'}
          </div>
          <button className="ic-export-button" type="button" onClick={exportJson} disabled={!liveSession} title="Bereinigte Request-Metadaten als JSON exportieren" data-testid="button-export-live-json"><ArrowDownToLine size={14} /> JSON</button>
          <button className="ic-icon-button" type="button" onClick={onClose} aria-label="Aufzeichnungsfenster schließen" data-testid="button-close-capture"><X size={17} /></button>
        </div>
      </header>

      <div className="ic-session-bar">
        <div className="ic-address"><Globe2 size={15} /><span title={safeUrl(liveSession?.url || initialUrl)}>{safeUrl(liveSession?.url || initialUrl)}</span><ArrowUpRight size={13} /></div>
        <div className="ic-session-meta">
          <span data-testid="capture-request-count"><Activity size={13} />{liveSession?.requestCount ?? 0} Requests</span>
          <span data-testid="capture-session-duration"><Clock3 size={13} />{formatDuration(liveSession?.durationMs)}</span>
        </div>
      </div>

      <div className="ic-main-grid">
        <section className="ic-browser-panel" aria-label="Remote browser viewport">
          <div className="ic-browser-toolbar">
            <div className="ic-browser-dots" aria-hidden="true"><i /><i /><i /></div>
            <span className="ic-browser-caption">REMOTE BROWSER <span>{liveSession?.viewportWidth || '—'} × {liveSession?.viewportHeight || '—'}</span></span>
            <span className="ic-viewport-hint"><MousePointer2 size={13} /> Klicken · scrollen · tippen</span>
          </div>
          <div
            ref={viewportRef}
            className={`ic-viewport ${screenshotSrc ? 'has-image' : ''}`}
            tabIndex={0}
            role="application"
            aria-label="Remote-Browser. Zum Bedienen klicken, dann Tastatur verwenden. Einfügen ist deaktiviert."
            onClick={handleViewportClick}
            onWheel={handleWheel}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onContextMenu={(event) => event.preventDefault()}
            data-testid="capture-remote-viewport"
          >
            {screenshotSrc ? (
              <img src={screenshotSrc} alt="Live-Ansicht der freigegebenen öffentlichen Website" draggable={false} data-testid="capture-remote-screenshot" />
            ) : (
              <div className="ic-viewport-empty" data-testid="capture-viewport-state">
                {isStarting ? <><span className="ic-skeleton ic-skeleton-wide" /><span className="ic-skeleton" /><span className="ic-skeleton ic-skeleton-short" /><span className="ic-loading-copy">Sicherer Browser wird geöffnet…</span></> : isClosed ? <><CircleStop size={25} /><strong>Sitzung beendet</strong><span>Der Remote-Browser ist nicht mehr verfügbar.</span></> : sessionQuery.isError || start.isError ? <><ShieldCheck size={24} /><strong>Browseransicht nicht verfügbar</strong><span>{endError || 'Die Sitzung kann nicht erreicht werden.'}</span></> : <><Globe2 size={24} /><strong>Warte auf Seitenansicht</strong><span>Die Browseransicht erscheint nach dem Laden.</span></>}
              </div>
            )}
            {screenshotSrc && <div className="ic-viewport-focus">Ansicht anklicken, um die Tastatur zu verwenden</div>}
          </div>
          <div className="ic-browser-footer">
            <span><ShieldCheck size={13} /> Keine Zugangsdaten, Header oder Inhalte werden angezeigt</span>
            <div className="ic-browser-actions">
              <button type="button" className={`ic-record-button ${liveSession?.recording ? 'recording' : ''}`} onClick={toggleRecording} disabled={!sessionId || isClosed || recording.isPending} aria-pressed={!!liveSession?.recording} data-testid="button-toggle-recording">
                {liveSession?.recording ? <Pause size={14} /> : <Play size={14} />}{liveSession?.recording ? 'Aufzeichnung stoppen' : 'Aufzeichnung starten'}
              </button>
              <button type="button" className="ic-end-button" onClick={endSession} disabled={!sessionId || isClosed || end.isPending} data-testid="button-end-session">
                <CircleStop size={14} />Sitzung beenden
              </button>
            </div>
          </div>
        </section>

           <section className="ic-requests-panel" aria-label="Bereinigte Request-Metadaten">
          <div className="ic-requests-heading">
            <div><div className="ic-section-label">ERFASSTE METADATEN</div><h3>Requests <span data-testid="capture-visible-count">{visibleRequests.length}</span></h3></div>
            <span className="ic-safety-badge"><ShieldCheck size={13} /> Bereinigt</span>
          </div>
          <label className="ic-search">
            <Search size={15} />
            <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Hosts, Pfade, Methoden suchen…" aria-label="Request-Metadaten durchsuchen" data-testid="input-capture-search" />
            {search && <button type="button" onClick={() => setSearch('')} aria-label="Suche leeren" data-testid="button-clear-capture-search"><X size={13} /></button>}
          </label>
          <div className="ic-quick-search" role="group" aria-label="Schnellsuche" data-testid="capture-quick-searches">
            {quickTerms.map((term) => <button type="button" key={term} className={search.toLowerCase() === term ? 'active' : ''} onClick={() => setSearch(search.toLowerCase() === term ? '' : term)} data-testid={`quick-search-${term}`}>{term}</button>)}
          </div>
          <div className="ic-isolation-bar">
            <div className="ic-candidate-count"><Activity size={12} /><strong>{apiCandidateCount}</strong> API-Kandidaten</div>
            <div className="ic-isolation-actions">
              <button type="button" className={onlyNewRequests ? 'active' : ''} onClick={markCurrentTraffic} disabled={!liveSession} data-testid="button-mark-current-traffic">Ab hier beobachten</button>
              {onlyNewRequests && <button type="button" onClick={showAllTraffic} data-testid="button-show-all-traffic">Alle wieder zeigen</button>}
            </div>
          </div>
          {onlyNewRequests && <div className="ic-isolation-note" data-testid="capture-isolation-note"><Check size={12} /> Nur Requests nach deinem Marker werden angezeigt. Jetzt eine Aktion auf der Website ausführen.</div>}
          <div className="ic-filter-tabs" role="group" aria-label="Requests nach Typ filtern">
            {filters.map((option) => <button type="button" key={option.value} onClick={() => setFilter(option.value)} className={filter === option.value ? 'active' : ''} aria-pressed={filter === option.value} data-testid={`capture-filter-${option.value}`}>{option.label}</button>)}
          </div>
          <div className="ic-table-wrap">
            <table className="ic-table">
              <thead><tr><th>ZEIT</th><th>REQUEST</th><th>STATUS</th><th>TYP</th><th>CONTENT-TYPE</th><th>DAUER</th></tr></thead>
              <tbody>
                {visibleRequests.map((request) => <RequestRow key={request.id} request={request} />)}
              </tbody>
            </table>
            {visibleRequests.length === 0 && (
              <div className="ic-empty" data-testid="capture-requests-empty">
                <div className="ic-empty-icon">{search || filter !== 'all' ? <Search size={17} /> : <Activity size={17} />}</div>
                <strong>{search || filter !== 'all' || onlyNewRequests ? 'Keine passenden Requests' : liveSession?.recording ? 'Warte auf Requests' : 'Aufzeichnung pausiert'}</strong>
                <span>{onlyNewRequests ? 'Führe jetzt die gewünschte Aktion im Remote-Browser aus. Neue Requests erscheinen hier.' : search || filter !== 'all' ? 'Ändere den Suchbegriff oder Request-Typ.' : 'Bereinigte Metadaten erscheinen, solange die Aufzeichnung läuft.'}</span>
              </div>
            )}
          </div>
          <div className="ic-privacy-foot"><ShieldCheck size={13} /><span>Abfrageparameter, Bodies, Header, Cookies und Tokens werden nicht angezeigt oder gespeichert. Der JSON-Export enthält nur bereinigte Metadaten.</span></div>
        </section>
      </div>

      {(endError || interactionError || sessionQuery.isError) && !isClosed && <div className="ic-error" role="status" data-testid="capture-session-error">{endError || interactionError || 'Die Live-Sitzung konnte nicht aktualisiert werden.'}</div>}
       <footer className="ic-footer"><span><Check size={13} /> Nur berechtigte Analyse öffentlicher Websites</span><span>Sitzungsdaten bleiben nur im Arbeitsspeicher</span></footer>
    </section>
  );
}

export default InteractiveCapture;