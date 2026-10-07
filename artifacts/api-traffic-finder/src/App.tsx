import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAnalyzeTraffic, useHealthCheck, getHealthCheckQueryKey } from '@workspace/api-client-react';
import type { TrafficAnalysisResult, TrafficRequest } from '@workspace/api-client-react';
import { AlertCircle, ArrowDownToLine, ArrowUpRight, Check, ChevronDown, Clock3, Database, Globe2, MousePointer2, Search, ShieldCheck, Sparkles, X } from 'lucide-react';
import { ErrorBoundary } from '@/components/error-boundary';
import InteractiveCapture from '@/components/interactive-capture';
import { EndpointGroups, SchemaFields, downloadTrafficJson } from '@/components/traffic-insights';
import { matchesRequestFilter, requestSearchText } from '@workspace/traffic-core';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, useLocation, Router as WouterRouter } from 'wouter';
import './index.css';

const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: 0 }, mutations: { gcTime: 0 } } });
const filterOptions = [
  { label: 'Alle', value: 'all' },
  { label: 'Fetch / XHR', value: 'fetch-xhr' },
  { label: 'REST', value: 'rest' },
  { label: 'GraphQL', value: 'graphql' },
  { label: 'WebSocket', value: 'websocket' },
] as const;
type RequestFilter = (typeof filterOptions)[number]['value'];

const typeNames: Record<TrafficRequest['type'], string> = {
  'fetch-xhr': 'Fetch / XHR',
  rest: 'REST',
  graphql: 'GraphQL',
  websocket: 'WebSocket',
};

function formatDuration(ms: number | null | undefined) {
  if (ms == null) return '—';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

function formatTime(date: string) {
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return date;
  return new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(parsed);
}

function safeError(error: unknown) {
  if (error && typeof error === 'object' && 'error' in error && typeof error.error === 'string') return error.error;
  if (error instanceof Error) return error.message;
  return 'Die Analyse konnte nicht abgeschlossen werden. Bitte versuche es erneut.';
}

function HealthIndicator() {
  const health = useHealthCheck({
    query: { queryKey: getHealthCheckQueryKey(), refetchInterval: 30_000, retry: 1 },
  });
  const ready = health.data?.status === 'ok' || health.data?.status === 'healthy';
  const label = health.isLoading ? 'Verbindung wird geprüft' : health.isError ? 'Dienst nicht erreichbar' : ready ? 'Dienst verbunden' : `Dienst: ${health.data?.status ?? 'unbekannt'}`;
  return (
    <div className={`health-pill ${health.isError ? 'is-down' : ready ? 'is-up' : 'is-pending'}`} data-testid="status-api-health" title={health.isError ? 'Verbindung zur API derzeit nicht möglich' : label}>
      <span className="health-dot" />
      <span>{label}</span>
    </div>
  );
}

function Metric({ label, value, detail, tone = '' }: { label: string; value: string | number; detail?: string; tone?: string }) {
  return (
    <div className={`metric ${tone}`} data-testid={`metric-${label.toLowerCase().replaceAll(' ', '-')}`}>
      <span className="metric-label">{label}</span>
      <strong>{value}</strong>
      {detail && <span className="metric-detail">{detail}</span>}
    </div>
  );
}

function RequestRow({ request }: { request: TrafficRequest }) {
  const statusClass = request.statusCode == null ? 'status-unknown' : request.statusCode >= 400 ? 'status-error' : request.statusCode >= 300 ? 'status-redirect' : 'status-ok';
  return (
    <tr data-testid={`row-request-${request.id}`}>
      <td className="time-cell mono">{formatTime(request.startedAt)}</td>
      <td>
        <div className="request-route" title={request.url}>
          <span className="method-chip">{request.method}</span>
          <span className="route-text mono">{request.url}</span>
          <span className="route-meta mono">{request.hostname} · {request.path}</span>
          {request.isApiCandidate && <span className="candidate-badge" title={request.candidateReasons.join(" · ")}>API-Kandidat</span>}
        </div>
      </td>
      <td><span className={`status-chip ${statusClass}`}>{request.statusCode ?? '—'}</span></td>
      <td><span className="type-badge">{typeNames[request.type]}</span></td>
      <td className="resource-cell">{request.resourceType || '—'}</td>
      <td className="content-cell mono">{request.contentType || '—'}</td>
      <td className="duration-cell mono">{formatDuration(request.durationMs)}</td>
      <td><SchemaFields schema={request.jsonSchema} /></td>
    </tr>
  );
}

function Results({ result }: { result: TrafficAnalysisResult }) {
  const [filter, setFilter] = useState<RequestFilter>('all');
  const [search, setSearch] = useState('');
  const [candidatesOnly, setCandidatesOnly] = useState(false);
  const visibleRequests = useMemo(() => {
    const query = search.trim().toLocaleLowerCase('de');
    return result.requests.filter((request) => {
      const matchesFilter = matchesRequestFilter(request, filter) && (!candidatesOnly || request.isApiCandidate);
      const searchable = requestSearchText(request);
      return matchesFilter && (!query || searchable.includes(query));
    });
  }, [filter, result.requests, search, candidatesOnly]);

  const exportJson = () => downloadTrafficJson(result);

  return (
    <section className="results-section fade-in" aria-label="Analyseergebnis" data-testid="section-analysis-results">
      <div className="results-heading">
        <div>
          <div className="section-kicker"><span className="kicker-rule" /> Analyseergebnis</div>
          <h2>Netzwerkübersicht</h2>
          <p className="result-url mono" title={result.url}><Globe2 size={14} />{result.url}</p>
        </div>
        <button className="button button-secondary export-button" onClick={exportJson} data-testid="button-export-json">
          <ArrowDownToLine size={16} /> JSON exportieren
        </button>
      </div>

      <div className="metric-grid">
        <Metric label="Requests" value={result.requestCount} detail="erfasst" />
        <Metric label="Fetch / XHR" value={result.counts.fetchXhr} detail="Anfragen" tone="metric-green" />
        <Metric label="REST" value={result.counts.rest} detail="Endpunkte" tone="metric-blue" />
        <Metric label="GraphQL" value={result.counts.graphql} detail="Anfragen" tone="metric-violet" />
        <Metric label="WebSocket" value={result.counts.websocket} detail="Verbindungen" tone="metric-orange" />
        <Metric label="API-Kandidaten" value={result.requests.filter(request => request.isApiCandidate).length} detail="beobachtete Hinweise" />
        <Metric label="Blockiert" value={result.blockedCount} detail="durch Browser" tone="metric-muted" />
      </div>

      {result.warnings.length > 0 && <div className="capture-warnings" role="status">{result.warnings.map(warning => <p key={warning}>{warning}</p>)}</div>}
      <div className="table-panel">
        <div className="table-toolbar">
          <div className="table-title">
            <h3>Requests</h3><span className="row-count">{visibleRequests.length} / {result.requests.length}</span>
          </div>
          <div className="table-controls">
            <label className="search-box">
              <Search size={15} />
              <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Requests durchsuchen…" aria-label="Requests durchsuchen" data-testid="input-request-search" />
              {search && <button type="button" className="search-clear" onClick={() => setSearch('')} aria-label="Suche leeren" data-testid="button-clear-search"><X size={14} /></button>}
            </label>
          </div>
        </div>
        <label className="candidate-filter"><input type="checkbox" checked={candidatesOnly} onChange={event => setCandidatesOnly(event.target.checked)} data-testid="filter-api-candidates" /> Nur API-Kandidaten</label>
        <div className="filter-row" role="group" aria-label="Request-Typ filtern">
          {filterOptions.map((option) => (
            <button key={option.value} className={`filter-chip ${filter === option.value ? 'selected' : ''}`} onClick={() => setFilter(option.value)} aria-pressed={filter === option.value} data-testid={`filter-${option.value}`}>
              {option.label}
            </button>
          ))}
        </div>
        {visibleRequests.length > 0 ? (
          <div className="table-scroll">
            <table>
              <thead><tr><th>Zeit</th><th>Request</th><th>Status</th><th>Typ</th><th>Ressource</th><th>Content-Type</th><th>Dauer</th><th>JSON-Schema-Feldnamen</th></tr></thead>
              <tbody>{visibleRequests.map((request) => <RequestRow key={request.id} request={request} />)}</tbody>
            </table>
          </div>
        ) : (
          <div className="table-empty" data-testid="empty-filtered-requests">
            <Search size={20} />
            <strong>Keine passenden Requests</strong>
            <span>Ändere den Filter oder suche nach einem anderen Begriff.</span>
          </div>
        )}
        <div className="table-footnote"><Clock3 size={13} /> Erfasst am {formatTime(result.capturedAt)} · Laufzeit {formatDuration(result.durationMs)}</div>
      </div>
      <EndpointGroups requests={visibleRequests} />
    </section>
  );
}

function Home() {
  const [url, setUrl] = useState('');
  const [duration, setDuration] = useState('8');
  const [hasPermission, setHasPermission] = useState(false);
  const [interactiveUrl, setInteractiveUrl] = useState('');
  const analyze = useAnalyzeTraffic();
  const result = analyze.data;
  const interactiveOpen = Boolean(interactiveUrl);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    let normalized: URL;
    try {
      normalized = new URL(url.trim().match(/^https?:\/\//i) ? url.trim() : `https://${url.trim()}`);
    } catch {
      return;
    }
    if (!['http:', 'https:'].includes(normalized.protocol) || !hasPermission) return;
    analyze.mutate({ data: { url: normalized.toString(), captureDurationSeconds: Number(duration), authorized: true } });
  };

  let validUrl = false;
  try {
    const candidate = new URL(url.trim().match(/^https?:\/\//i) ? url.trim() : `https://${url.trim()}`);
    validUrl = ['http:', 'https:'].includes(candidate.protocol) && !!candidate.hostname;
  } catch { validUrl = false; }

  const openInteractiveSession = () => {
    if (!validUrl || !hasPermission) return;
    try {
      const normalized = new URL(url.trim().match(/^https?:\/\//i) ? url.trim() : `https://${url.trim()}`);
      if (['http:', 'https:'].includes(normalized.protocol)) setInteractiveUrl(normalized.toString());
    } catch {
      setInteractiveUrl('');
    }
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Traffic Finder Startseite">
          <span className="brand-mark"><span /><span /><span /></span>
          <span className="brand-name">traffic<span>finder</span></span>
          <span className="brand-divider" />
          <span className="brand-caption">WEB INSPECTOR</span>
        </a>
        <HealthIndicator />
      </header>

      <div className="main-content">
        <section className="intro">
          <div className="intro-copy">
            <div className="eyebrow"><span className="eyebrow-dot" /> ÖFFENTLICHER WEB-TRAFFIC</div>
            <h1>Verbindungen sichtbar.<br /><span>Details geschützt.</span></h1>
            <p>Analysiere Requests einer öffentlichen Website – ohne Inhalte, Header oder Zugangsdaten offenzulegen.</p>
          </div>
          <div className="intro-art" aria-hidden="true">
            <div className="art-orbit orbit-one" /><div className="art-orbit orbit-two" />
            <div className="art-core"><span className="core-line line-a" /><span className="core-line line-b" /><span className="core-line line-c" /><i /></div>
            <div className="art-node node-a" /><div className="art-node node-b" /><div className="art-node node-c" />
            <span className="art-label">SAFE CAPTURE / 01</span>
          </div>
        </section>

        <section className="analyzer-card" aria-label="Website analysieren">
          <div className="form-heading">
            <div className="form-icon"><ArrowUpRight size={18} /></div>
            <div><h2>Website analysieren</h2><p>Gib die Adresse einer Website ein, für die du eine Berechtigung hast.</p></div>
          </div>
          <form onSubmit={submit}>
            <label className="field-label" htmlFor="site-url">Website-Adresse</label>
            <div className="input-row">
              <div className="url-input-wrap">
                <Globe2 size={17} />
                <input id="site-url" type="text" autoComplete="url" inputMode="url" placeholder="https://beispiel.de" value={url} onChange={(event) => setUrl(event.target.value)} aria-describedby="url-hint" data-testid="input-site-url" disabled={interactiveOpen} />
                {url && !interactiveOpen && <button type="button" className="input-clear" onClick={() => setUrl('')} aria-label="Adresse leeren" data-testid="button-clear-url"><X size={15} /></button>}
              </div>
              <label className="duration-select" aria-label="Erfassungsdauer">
                <Clock3 size={15} />
                <select value={duration} onChange={(event) => setDuration(event.target.value)} data-testid="select-capture-duration" disabled={interactiveOpen}>
                  <option value="3">3 Sek.</option><option value="5">5 Sek.</option><option value="8">8 Sek.</option><option value="10">10 Sek.</option><option value="15">15 Sek.</option>
                </select>
                <ChevronDown size={13} />
              </label>
              <button type="submit" className="button button-primary analyze-button" disabled={!validUrl || !hasPermission || analyze.isPending || interactiveOpen} data-testid="button-start-analysis">
                {analyze.isPending ? <><span className="button-loader" /> Analysiert…</> : <><span>Analyse starten</span><ArrowUpRight size={16} /></>}
              </button>
            </div>
            <span className="field-hint" id="url-hint">Nur öffentliche Websites mit HTTP oder HTTPS.</span>
            <label className="permission-check">
              <input type="checkbox" checked={hasPermission} onChange={(event) => setHasPermission(event.target.checked)} data-testid="checkbox-permission" disabled={interactiveOpen} />
              <span className="custom-check"><Check size={12} /></span>
              <span>Ich bin berechtigt, den Netzwerkverkehr dieser Website zu analysieren.</span>
            </label>
            {analyze.isPending && (
              <div className="capture-progress" role="status" data-testid="status-analysis-loading">
                <div className="progress-skeleton"><i /></div><span>Öffentliche Seite wird geladen und Requests werden erfasst…</span>
              </div>
            )}
            {analyze.isError && (
              <div className="error-notice" role="alert" data-testid="status-analysis-error">
                <AlertCircle size={17} /><div><strong>Analyse fehlgeschlagen</strong><span>{safeError(analyze.error)}</span></div>
                <button type="button" className="retry-button" onClick={() => analyze.mutate({ data: { url: new URL(url.trim().match(/^https?:\/\//i) ? url.trim() : `https://${url.trim()}`).toString(), captureDurationSeconds: Number(duration), authorized: true } })} disabled={!validUrl || !hasPermission || interactiveOpen || analyze.isPending} data-testid="button-retry-analysis">Erneut versuchen</button>
              </div>
            )}
            {!interactiveOpen && (
              <div className="interactive-launch-row">
                <button type="button" className="button button-secondary interactive-launch-button" onClick={openInteractiveSession} disabled={!validUrl || !hasPermission || analyze.isPending} data-testid="button-open-interactive-session">
                  <MousePointer2 size={15} /> Interaktive Sitzung öffnen
                </button>
                <span>Website selbst bedienen; Requests live erfassen.</span>
              </div>
            )}
          </form>
          <div className="privacy-note"><ShieldCheck size={15} /><span>Abfrageparameter werden entfernt. Im interaktiven Modus bedienst du die Website selbst; nichts wird automatisch angeklickt. JSON-Antworten werden nur kurz für Feldnamen und Datentypen ausgewertet. Antwortwerte, Bodies, Header, Cookies und Tokens werden nicht gespeichert oder exportiert.</span></div>
        </section>

        {interactiveOpen ? (
          <InteractiveCapture initialUrl={interactiveUrl} onClose={() => setInteractiveUrl('')} />
        ) : result ? <Results key={result.capturedAt} result={result} /> : (
          <section className="empty-results" data-testid="empty-analysis-state">
            <div className="empty-mark"><Database size={20} /><span /></div>
            <div><strong>Deine Analyse erscheint hier</strong><p>Starte eine Erfassung, um Requests, Typen und Antwortzeiten zu überblicken.</p></div>
            <div className="empty-meta"><Sparkles size={14} /> Nur Metadaten. Keine Inhalte.</div>
          </section>
        )}

        <section className="safety-strip" aria-label="Datenschutz und Nutzung">
          <div className="safety-item"><span className="safety-icon"><ShieldCheck size={16} /></span><div><strong>Datensparsam</strong><span>Nur bereinigte Request-Metadaten</span></div></div>
          <div className="safety-separator" />
          <div className="safety-item"><span className="safety-icon"><Globe2 size={16} /></span><div><strong>Öffentlich zugänglich</strong><span>Keine Anmeldung oder Sitzungscookies</span></div></div>
          <div className="safety-separator" />
          <div className="safety-item"><span className="safety-icon"><Database size={16} /></span><div><strong>Nur im Browser</strong><span>Ergebnisse bleiben im aktuellen Browserzustand</span></div></div>
        </section>
      </div>
      <footer className="page-footer"><span>API TRAFFIC FINDER</span><span>Analysiere nur Websites, für die du eine ausdrückliche Berechtigung hast.</span></footer>
    </main>
  );
}

function Router() {
  return <RoutedErrorBoundary><Switch><Route path="/" component={Home} /><Route component={NotFound} /></Switch></RoutedErrorBoundary>;
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><Router /></WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;