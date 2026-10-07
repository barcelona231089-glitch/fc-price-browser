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
import { useQueryClient } from '@tanstack/react-query';
import { EndpointGroups, SchemaFields, downloadTrafficJson } from './traffic-insights';
import { matchesRequestFilter, requestSearchText } from '@workspace/traffic-core';
import { Activity, ArrowDownToLine, ArrowUpRight, Check, CircleStop, Clock3, Globe2, MousePointer2, Pause, Play, Search, ShieldCheck, X } from 'lucide-react';
import './interactive-capture.css';

type Filter = 'all' | TrafficRequestType;

const filters: { label: string; value: Filter }[] = [
  { label: 'Alle', value: 'all' },
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
  return (
    <tr data-testid={`capture-request-${request.id}`}>
      <td className="ic-time">{formatTime(request.startedAt)}</td>
      <td>
        <div className="ic-route" title={safeUrl(request.url)}>
          <span className="ic-method">{request.method}</span>
          <span className="ic-route-url">{safeUrl(request.url)}</span>
          <span className="ic-host">{request.hostname}</span>
          <span className="ic-path">{request.path}</span>
          {request.isApiCandidate && <span className="candidate-badge" title={request.candidateReasons.join(" · ")}>API-Kandidat</span>}
        </div>
      </td>
      <td><span className={`ic-status ic-status-${statusClass}`}>{request.statusCode ?? '—'}</span></td>
      <td><span className="ic-type">{requestTypeLabel(request.type)}</span></td>
      <td className="ic-content">{request.resourceType}</td>
      <td className="ic-content" title={request.contentType ?? ''}>{request.contentType || '—'}</td>
      <td className="ic-duration">{formatDuration(request.durationMs)}</td>
      <td><SchemaFields schema={request.jsonSchema} /></td>
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
  const [candidatesOnly, setCandidatesOnly] = useState(false);
  const [interactionError, setInteractionError] = useState('');
  const queryClient = useQueryClient();
  const [ended, setEnded] = useState(false);
  const [endError, setEndError] = useState('');
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
      enabled: !!sessionId && !ended && !recording.isPending,
      queryKey: getGetTrafficSessionStateQueryKey({ sessionId }),
      refetchInterval: sessionId && !ended ? 1000 : false,
      retry: false,
      gcTime: 0,
    },
  });
  const liveSession = sessionQuery.data ?? session;

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    start.mutateAsync({ data: { url: initialUrl, authorized: true } }).then((state) => {
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
        void queryClient.cancelQueries({ queryKey: getGetTrafficSessionStateQueryKey({ sessionId: id }) });
        queryClient.removeQueries({ queryKey: getGetTrafficSessionStateQueryKey({ sessionId: id }) });
        end.mutate({ data: { sessionId: id } });
      }
    };
  // Session creation is intentionally once per mounted capture.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (sessionQuery.data) setSession(sessionQuery.data);
  }, [sessionQuery.data]);

  useEffect(() => {
    if (sessionQuery.isError && (sessionQuery.error as { status?: number })?.status === 404) {
      endedRef.current = true;
      setEnded(true);
      setEndError('Die Sitzung wurde beendet oder ist abgelaufen.');
    }
  }, [sessionQuery.isError, sessionQuery.error]);

  const sendInteraction = useCallback((action: 'click' | 'scroll' | 'key', fields: { x?: number; y?: number; deltaX?: number; deltaY?: number; key?: string }) => {
    const id = sessionIdRef.current;
    if (!id || endedRef.current) return;
    interactionQueue.current = interactionQueue.current
      .catch(() => undefined)
      .then(() => interact.mutateAsync({ data: { sessionId: id, action, ...fields } }))
      .then(() => setInteractionError(''))
      .catch(() => setInteractionError('Diese Aktion konnte nicht ausgeführt werden. Eingaben in Zugangsdaten-Feldern sind gesperrt.')); 
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
    sendInteraction('scroll', { deltaX: Math.max(-1280, Math.min(1280, Math.round(event.deltaX * factorX))), deltaY: Math.max(-1600, Math.min(1600, Math.round(event.deltaY * factorY))) });
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

  const changeRecording = async (reset = false) => {
    if (!liveSession || !sessionId) return;
    await queryClient.cancelQueries({ queryKey: getGetTrafficSessionStateQueryKey({ sessionId }) });
    recording.mutate({ data: { sessionId, recording: reset || !liveSession.recording, reset } }, {
      onSuccess: (state) => {
        setSession(state);
        queryClient.setQueryData(getGetTrafficSessionStateQueryKey({ sessionId }), state);
        setInteractionError('');
      },
      onError: () => setInteractionError('Aufzeichnung konnte nicht geändert werden.'),
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
      await queryClient.cancelQueries({ queryKey: getGetTrafficSessionStateQueryKey({ sessionId: id }) });
      queryClient.removeQueries({ queryKey: getGetTrafficSessionStateQueryKey({ sessionId: id }) });
      setEnded(true);
      onClose();
    } catch {
      endedRef.current = false;
      setEndError('Die Sitzung konnte nicht geschlossen werden. Bitte versuche es erneut.');
    }
  };

  const visibleRequests = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return (liveSession?.requests ?? []).filter((request) => {
      const matchingType = matchesRequestFilter(request, filter) && (!candidatesOnly || request.isApiCandidate);
      const terms = requestSearchText(request);
      return matchingType && (!needle || terms.includes(needle));
    });
  }, [filter, liveSession?.requests, search, candidatesOnly]);

  const screenshotSrc = liveSession?.screenshot
    ? liveSession.screenshot.startsWith('data:') ? liveSession.screenshot : `data:image/jpeg;base64,${liveSession.screenshot}`
    : '';
  const isStarting = start.isPending && !liveSession;
  const isClosed = ended || liveSession?.closed;

  return (
    <section className="ic-workbench" aria-label="Interaktive Verkehrsanalyse" data-testid="interactive-capture">
      <header className="ic-header">
        <div className="ic-heading">
          <div className="ic-mark"><Activity size={17} /></div>
          <div>
        <div className="ic-eyebrow">LIVE-SITZUNG <span>·</span> BERECHTIGTE ANALYSE</div>
            <h2>Interaktive Aufzeichnung</h2>
          </div>
        </div>
        <div className="ic-header-actions">
          <button className="button button-secondary" type="button" onClick={() => liveSession && downloadTrafficJson(liveSession)} disabled={!liveSession} data-testid="button-export-capture-json"><ArrowDownToLine size={14} /> JSON exportieren</button>
          <div className={`ic-live-pill ${liveSession?.recording ? 'is-recording' : ''}`} data-testid="status-capture-recording">
            <span />{isClosed ? 'Sitzung beendet' : liveSession?.recording ? 'Aufzeichnung läuft' : 'Pausiert'}
          </div>
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

      {!!liveSession?.warnings.length && <div className="capture-warnings" role="status">{liveSession.warnings.map(warning => <p key={warning}>{warning}</p>)}</div>}
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
            <span><ShieldCheck size={13} /> Zugangsdaten-Felder sind verdeckt; keine Antwortwerte im Export</span>
            <div className="ic-browser-actions">
              <button type="button" className="ic-record-button" onClick={() => changeRecording(true)} disabled={!sessionId || isClosed || recording.isPending} data-testid="button-observe-from-here">Ab hier beobachten</button>
              <button type="button" className={`ic-record-button ${liveSession?.recording ? 'recording' : ''}`} onClick={() => changeRecording()} disabled={!sessionId || isClosed || recording.isPending} aria-pressed={!!liveSession?.recording} data-testid="button-toggle-recording">
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
          <label className="candidate-filter"><input type="checkbox" checked={candidatesOnly} onChange={event => setCandidatesOnly(event.target.checked)} data-testid="capture-filter-api-candidates" /> Nur API-Kandidaten</label>
          <div className="ic-filter-tabs" role="group" aria-label="Requests nach Typ filtern">
            {filters.map((option) => <button type="button" key={option.value} onClick={() => setFilter(option.value)} className={filter === option.value ? 'active' : ''} aria-pressed={filter === option.value} data-testid={`capture-filter-${option.value}`}>{option.label}</button>)}
          </div>
          <div className="ic-table-wrap">
            <table className="ic-table">
              <thead><tr><th>ZEIT</th><th>REQUEST</th><th>STATUS</th><th>TYP</th><th>RESSOURCE</th><th>CONTENT-TYPE</th><th>DAUER</th><th>JSON-SCHEMA-FELDNAMEN</th></tr></thead>
              <tbody>
                {visibleRequests.map((request) => <RequestRow key={request.id} request={request} />)}
              </tbody>
            </table>
            {visibleRequests.length === 0 && (
              <div className="ic-empty" data-testid="capture-requests-empty">
                <div className="ic-empty-icon">{search || filter !== 'all' ? <Search size={17} /> : <Activity size={17} />}</div>
                <strong>{search || filter !== 'all' ? 'Keine passenden Requests' : liveSession?.recording ? 'Warte auf Requests' : 'Aufzeichnung pausiert'}</strong>
                <span>{search || filter !== 'all' ? 'Ändere den Suchbegriff oder Request-Typ.' : 'Bereinigte Metadaten erscheinen, solange die Aufzeichnung läuft.'}</span>
              </div>
            )}
          </div>
          <div className="ic-privacy-foot"><ShieldCheck size={13} /><span>Nur Metadaten, Feldnamen und Datentypen. Keine Antwortwerte, Parameter, Header, Cookies oder Tokens im Export.</span></div>
        </section>
      </div>

      <EndpointGroups requests={visibleRequests} />
      {(endError || interactionError || sessionQuery.isError) && !isClosed && <div className="ic-error" role="status" data-testid="capture-session-error">{endError || interactionError || 'Die Live-Sitzung konnte nicht aktualisiert werden.'}</div>}
       <footer className="ic-footer"><span><Check size={13} /> Nur berechtigte Analyse öffentlicher Websites</span><span>Sitzungsdaten bleiben nur im Arbeitsspeicher</span></footer>
    </section>
  );
}

export default InteractiveCapture;