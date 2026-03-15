
export interface ClusterPoint {
  id: string;
  embedding: number[];
}

export interface DBSCANOptions {
  eps: number;       // Distance threshold (cosine distance, 0-2 range)
  minSamples: number; // Minimum points to form a core point
}

/** Cosine distance: 1 - cosine_similarity. Range: 0 (identical) to 2 (opposite). */
function cosineDistance(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 2;
  return 1 - dot / denom;
}

function regionQuery(points: ClusterPoint[], pointIdx: number, eps: number): number[] {
  const neighbors: number[] = [];
  for (let i = 0; i < points.length; i++) {
    if (cosineDistance(points[pointIdx].embedding, points[i].embedding) <= eps) {
      neighbors.push(i);
    }
  }
  return neighbors;
}

/**
 * DBSCAN clustering on embedding vectors using cosine distance.
 * Noise points (unclustered) are returned as individual single-item clusters
 * so they are still processed during consolidation.
 */
export function dbscan(
  points: ClusterPoint[],
  options: DBSCANOptions,
): ClusterPoint[][] {
  if (points.length === 0) return [];

  const { eps, minSamples } = options;
  const labels = new Array<number>(points.length).fill(-1); // -1 = unvisited
  const NOISE = -2;
  let clusterId = 0;

  for (let i = 0; i < points.length; i++) {
    if (labels[i] !== -1) continue;

    const neighbors = regionQuery(points, i, eps);

    if (neighbors.length < minSamples) {
      labels[i] = NOISE;
      continue;
    }

    labels[i] = clusterId;
    const seedSet = [...neighbors.filter((n) => n !== i)];

    for (let j = 0; j < seedSet.length; j++) {
      const q = seedSet[j];
      if (labels[q] === NOISE) {
        labels[q] = clusterId;
      }
      if (labels[q] !== -1) continue;

      labels[q] = clusterId;
      const qNeighbors = regionQuery(points, q, eps);
      if (qNeighbors.length >= minSamples) {
        for (const n of qNeighbors) {
          if (!seedSet.includes(n)) seedSet.push(n);
        }
      }
    }

    clusterId++;
  }

  // Group into clusters
  const clusterMap = new Map<number, ClusterPoint[]>();
  for (let i = 0; i < points.length; i++) {
    const label = labels[i];
    if (label === NOISE) {
      // Noise points become individual clusters
      clusterMap.set(-(i + 1000), [points[i]]);
    } else {
      if (!clusterMap.has(label)) clusterMap.set(label, []);
      clusterMap.get(label)!.push(points[i]);
    }
  }

  return Array.from(clusterMap.values());
}
