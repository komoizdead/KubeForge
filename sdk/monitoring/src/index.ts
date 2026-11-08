export interface MetricSample {
  metric: string;
  labels: Record<string, string>;
  value: number;
  timestamp: string;
}

export interface MetricQuery {
  metric: string;
  match?: Record<string, string>;
  since?: string;
}

export interface MonitoringClient {
  query(query: MetricQuery): Promise<MetricSample[]>;
}

export function createInMemoryMonitoringClient(samples: MetricSample[] = []): MonitoringClient {
  return {
    async query(query) {
      return samples.filter((sample) => {
        if (sample.metric !== query.metric) return false;
        if (query.since && sample.timestamp < query.since) return false;
        for (const [key, value] of Object.entries(query.match ?? {})) {
          if (sample.labels[key] !== value) return false;
        }
        return true;
      });
    },
  };
}
