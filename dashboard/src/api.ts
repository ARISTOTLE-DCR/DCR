import type {
  Activity,
  AgentEvent,
  Snapshot,
  StatusResponse
} from "./types";

async function json<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json() as Promise<T>;
}

export function apiForToken(token?: string) {
  const prefix = token ? `/api/token/${encodeURIComponent(token)}` : "/api";
  return {
    status: () => json<StatusResponse>(`${prefix}/status`),
    snapshots: (limit = 180) =>
      json<{ snapshots: Snapshot[] }>(`${prefix}/snapshots?limit=${limit}`),
    activity: (limit = 100) =>
      json<{ activity: Activity[]; agentEvents: AgentEvent[] }>(
        `${prefix}/activity?limit=${limit}`
      ),
    stream: `${prefix}/stream`
  };
}
