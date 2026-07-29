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

export const api = {
  status: () => json<StatusResponse>("/api/status"),
  snapshots: (limit = 180) =>
    json<{ snapshots: Snapshot[] }>(`/api/snapshots?limit=${limit}`),
  activity: (limit = 100) =>
    json<{ activity: Activity[]; agentEvents: AgentEvent[] }>(
      `/api/activity?limit=${limit}`
    )
};
