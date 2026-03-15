import { describe, it, expect } from 'vitest';

describe('DBSCAN clustering', () => {
  it('clusters similar vectors together', async () => {
    const { dbscan } = await import('../../../src/consolidation/clustering.js');

    // 4 points: two near each other, two near each other, forming 2 clusters
    const points = [
      { id: 'a', embedding: [1.0, 0.0, 0.0] },
      { id: 'b', embedding: [0.99, 0.01, 0.0] },
      { id: 'c', embedding: [0.0, 1.0, 0.0] },
      { id: 'd', embedding: [0.01, 0.99, 0.0] },
    ];

    const clusters = dbscan(points, { eps: 0.3, minSamples: 2 });

    // Should produce 2 clusters
    expect(clusters.length).toBe(2);
    expect(clusters.some((c) => c.some((p) => p.id === 'a') && c.some((p) => p.id === 'b'))).toBe(true);
    expect(clusters.some((c) => c.some((p) => p.id === 'c') && c.some((p) => p.id === 'd'))).toBe(true);
  });

  it('treats unclustered points as individual clusters', async () => {
    const { dbscan } = await import('../../../src/consolidation/clustering.js');

    const points = [
      { id: 'a', embedding: [1.0, 0.0, 0.0] },
      { id: 'b', embedding: [0.0, 1.0, 0.0] },
      { id: 'c', embedding: [0.0, 0.0, 1.0] },
    ];

    // With minSamples=2, no cluster forms — all are noise
    const clusters = dbscan(points, { eps: 0.1, minSamples: 2 });

    // Noise points should be returned as individual clusters (each processed solo)
    expect(clusters.length).toBe(3);
    expect(clusters.every((c) => c.length === 1)).toBe(true);
  });

  it('handles empty input', async () => {
    const { dbscan } = await import('../../../src/consolidation/clustering.js');
    const clusters = dbscan([], { eps: 0.3, minSamples: 2 });
    expect(clusters).toEqual([]);
  });
});
