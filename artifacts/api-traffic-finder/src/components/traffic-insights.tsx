import type { TrafficRequest } from '@workspace/api-client-react';
import { groupEndpoints, jsonSchemaFields, sanitizedTrafficExport } from '@workspace/traffic-core';

export function SchemaFields({ schema }: { schema: unknown }) {
  const fields = jsonSchemaFields(schema);
  if (!fields.length) return <span className="schema-empty">—</span>;
  return (
    <details className="schema-details">
      <summary>{fields.length} Felder</summary>
      <div className="schema-fields">{fields.map(field => <code key={field}>{field}</code>)}</div>
    </details>
  );
}

export function EndpointGroups({ requests }: { requests: TrafficRequest[] }) {
  const groups = groupEndpoints(requests);
  return (
    <section className="endpoint-groups" aria-label="Endpoint-Gruppierung" data-testid="endpoint-groups">
      <div className="endpoint-heading"><h3>Endpoint-Gruppierung</h3><span>{groups.length} Endpunkte</span></div>
      <p>Gleiche Methode, Host und Pfad werden zusammengefasst. Numerische IDs und UUIDs erscheinen als :id. Schutzverkehr wie Cloudflare-Challenges wird nicht als Endpoint gruppiert.</p>
      {groups.length ? groups.map(group => (
        <details className="endpoint-group" key={group.key} data-testid="endpoint-group">
          <summary><span className="method-chip">{group.method}</span><code>{group.hostname}{group.path}</code><span>{group.requests.length}× · {group.type} · {group.averageDurationMs == null ? '—' : `${group.averageDurationMs} ms`}</span></summary>
          <div className="endpoint-details"><strong>JSON-Schema-Feldnamen</strong><div className="schema-fields">{group.fields.length ? group.fields.map(field => <code key={field}>{field}</code>) : <span>Keine JSON-Felder beobachtet.</span>}</div></div>
        </details>
      )) : <p>Für die aktuelle Suche sind keine Endpunkte vorhanden.</p>}
    </section>
  );
}

export function downloadTrafficJson(result: Parameters<typeof sanitizedTrafficExport>[0]) {
  const clean = sanitizedTrafficExport(result);
  const blob = new Blob([JSON.stringify(clean, null, 2)], { type: 'application/json' });
  const downloadUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = downloadUrl;
  link.download = `traffic-analyse-${clean.capturedAt.slice(0, 10)}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
}
