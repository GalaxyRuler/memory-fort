export interface RawObservationRef {
  relPath: string;
  created: string;
  entities: string[];
  source: string;
  title: string;
  snippet: string;
}

export interface ThreadCluster {
  observations: RawObservationRef[];
  sharedEntities: string[];
  timeRange: { start: string; end: string };
  cohesionScore: number;
}

export interface ThreadClusterOptions {
  minClusterSize?: number;
  maxClusterSize?: number;
  timeWindowDays?: number;
  minJaccard?: number;
}

const DEFAULT_MIN_CLUSTER_SIZE = 3;
const DEFAULT_MAX_CLUSTER_SIZE = 30;
const DEFAULT_TIME_WINDOW_DAYS = 7;
const DEFAULT_MIN_JACCARD = 0.5;
const DAY_MS = 24 * 60 * 60 * 1000;

interface WorkingCluster {
  observations: RawObservationRef[];
}

export function clusterRawObservations(
  observations: RawObservationRef[],
  opts: ThreadClusterOptions = {},
): ThreadCluster[] {
  const minClusterSize = Math.max(1, opts.minClusterSize ?? DEFAULT_MIN_CLUSTER_SIZE);
  const maxClusterSize = Math.max(1, opts.maxClusterSize ?? DEFAULT_MAX_CLUSTER_SIZE);
  const timeWindowDays = opts.timeWindowDays ?? DEFAULT_TIME_WINDOW_DAYS;
  const minJaccard = opts.minJaccard ?? DEFAULT_MIN_JACCARD;

  let clusters: WorkingCluster[] = observations
    .map(normalizeObservation)
    .sort(compareObservations)
    .map((observation) => ({ observations: [observation] }));

  let changed = true;
  while (changed) {
    changed = false;
    const next: WorkingCluster[] = [];
    for (let index = 0; index < clusters.length; index += 1) {
      const current = clusters[index]!;
      const following = clusters[index + 1];
      if (following && shouldMerge(current, following, timeWindowDays, minJaccard)) {
        next.push({
          observations: [...current.observations, ...following.observations].sort(compareObservations),
        });
        index += 1;
        changed = true;
      } else {
        next.push(current);
      }
    }
    clusters = next;
  }

  return clusters
    .flatMap((cluster) => splitCluster(cluster, maxClusterSize))
    .filter((cluster) =>
      cluster.observations.length >= minClusterSize &&
      cluster.observations.length <= maxClusterSize &&
      entitySet(cluster).size > 0
    )
    .map(toThreadCluster)
    .sort((a, b) =>
      b.cohesionScore * b.observations.length - a.cohesionScore * a.observations.length ||
      b.cohesionScore - a.cohesionScore ||
      a.timeRange.start.localeCompare(b.timeRange.start) ||
      a.observations[0]!.relPath.localeCompare(b.observations[0]!.relPath)
    );
}

function normalizeObservation(observation: RawObservationRef): RawObservationRef {
  return {
    ...observation,
    entities: uniqueSorted(observation.entities.filter((entity) => entity.trim().length > 0)),
  };
}

function shouldMerge(
  left: WorkingCluster,
  right: WorkingCluster,
  timeWindowDays: number,
  minJaccard: number,
): boolean {
  const leftEntities = entitySet(left);
  const rightEntities = entitySet(right);
  if (leftEntities.size === 0 || rightEntities.size === 0) return false;
  if (jaccard(leftEntities, rightEntities) < minJaccard) return false;
  return dayGap(clusterEnd(left), clusterStart(right)) <= timeWindowDays;
}

function splitCluster(cluster: WorkingCluster, maxClusterSize: number): WorkingCluster[] {
  if (cluster.observations.length <= maxClusterSize) return [cluster];
  const chunks: WorkingCluster[] = [];
  for (let index = 0; index < cluster.observations.length; index += maxClusterSize) {
    chunks.push({ observations: cluster.observations.slice(index, index + maxClusterSize) });
  }
  return chunks;
}

function toThreadCluster(cluster: WorkingCluster): ThreadCluster {
  const observations = cluster.observations;
  return {
    observations,
    sharedEntities: sharedEntities(observations),
    timeRange: {
      start: observations[0]!.created,
      end: observations[observations.length - 1]!.created,
    },
    cohesionScore: round(meanPairwiseJaccard(observations), 3),
  };
}

function sharedEntities(observations: RawObservationRef[]): string[] {
  const threshold = Math.ceil(observations.length * 0.5);
  const counts = new Map<string, number>();
  for (const observation of observations) {
    for (const entity of new Set(observation.entities)) {
      counts.set(entity, (counts.get(entity) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= threshold)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([entity]) => entity);
}

function meanPairwiseJaccard(observations: RawObservationRef[]): number {
  if (observations.length < 2) return 0;
  let total = 0;
  let count = 0;
  for (let i = 0; i < observations.length; i += 1) {
    for (let j = i + 1; j < observations.length; j += 1) {
      total += jaccard(new Set(observations[i]!.entities), new Set(observations[j]!.entities));
      count += 1;
    }
  }
  return count === 0 ? 0 : total / count;
}

function entitySet(cluster: WorkingCluster): Set<string> {
  return new Set(cluster.observations.flatMap((observation) => observation.entities));
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const value of left) {
    if (right.has(value)) intersection += 1;
  }
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : intersection / union;
}

function clusterStart(cluster: WorkingCluster): string {
  return cluster.observations[0]!.created;
}

function clusterEnd(cluster: WorkingCluster): string {
  return cluster.observations[cluster.observations.length - 1]!.created;
}

function dayGap(leftDate: string, rightDate: string): number {
  const left = Date.parse(`${leftDate}T00:00:00.000Z`);
  const right = Date.parse(`${rightDate}T00:00:00.000Z`);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return Number.POSITIVE_INFINITY;
  return Math.abs(right - left) / DAY_MS;
}

function compareObservations(left: RawObservationRef, right: RawObservationRef): number {
  return dateRank(left.created) - dateRank(right.created) || left.relPath.localeCompare(right.relPath);
}

function dateRank(value: string): number {
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
