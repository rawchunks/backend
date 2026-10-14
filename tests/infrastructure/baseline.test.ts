import { describe, expect, it } from 'vitest';
import { resources, deployments } from './manifests';

describe('Kubernetes manifest reference and resource baseline', () => {
  it('parses all manifests as structured YAML resources', () => {
    expect(resources.length).toBeGreaterThan(0);
    for (const resource of resources) {
      expect(resource.apiVersion).toBeTruthy();
      expect(resource.metadata.name).toBeTruthy();
      if (resource.kind === 'PersistentVolume') expect(resource.metadata.namespace).toBeUndefined();
      else expect(resource.metadata.namespace).toBe('rawchunks');
    }
  });
  it.each(deployments.map(d => [d.sourceFile, d]))('%s selector matches its own pod labels', (_, d) => {
    expect(d.spec.template.metadata.labels).toMatchObject(d.spec.selector.matchLabels);
  });
  it('every PVC volume references a declared claim and every mount has a volume', () => {
    const pvcs = resources.filter(x => x.kind === 'PersistentVolumeClaim').map(x => x.metadata.name);
    for (const deployment of deployments) {
      const volumes = deployment.spec.template.spec.volumes || [];
      for (const volume of volumes) if (volume.persistentVolumeClaim) expect(pvcs).toContain(volume.persistentVolumeClaim.claimName);
      for (const container of deployment.spec.template.spec.containers) for (const mount of container.volumeMounts || []) expect(volumes.map((v: any) => v.name)).toContain(mount.name);
    }
  });
  it('GPU deployments reserve one GPU, tolerate GPU taint and avoid RWO rolling update', () => {
    for (const deployment of deployments.filter(d => d.metadata.name.startsWith('acestep'))) {
      const spec = deployment.spec.template.spec;
      expect(spec.nodeSelector['cloud.google.com/gke-accelerator']).toBe('nvidia-l4');
      expect(spec.tolerations).toContainEqual(expect.objectContaining({ key: 'nvidia.com/gpu', effect: 'NoSchedule' }));
      expect(spec.containers[0].resources.requests['nvidia.com/gpu']).toBe(1);
      expect(spec.containers[0].resources.limits['nvidia.com/gpu']).toBe(1);
      expect(deployment.spec.strategy.type).toBe('Recreate');
      expect(deployment.spec.progressDeadlineSeconds).toBe(1200);
    }
  });
  it('ingress targets a declared service port and certificate with matching domain', () => {
    const ingress = resources.find(x => x.kind === 'Ingress')!;
    const backend = ingress.spec.rules[0].http.paths[0].backend.service;
    expect(resources.filter(x => x.kind === 'Service').some(x => x.metadata.name === backend.name && x.spec.ports.some((p: any) => p.port === backend.port.number))).toBe(true);
    const cert = resources.find(x => x.kind === 'ManagedCertificate' && x.metadata.name === ingress.metadata.annotations['networking.gke.io/managed-certificates']);
    expect(cert?.spec.domains).toContain(ingress.spec.rules[0].host);
  });
  it('downloaded model family names match configured primary and language models', () => {
    const download = resources.find(x => x.kind === 'Job')!.spec.template.spec.containers[0].args.join('');
    const worker = deployments.find(d => d.sourceFile === 'acestep-xl-15.yaml')!;
    for (const name of ['DEFAULT_DIT_MODEL','DEFAULT_LM_MODEL']) {
      const value = worker.spec.template.spec.containers[0].env.find((x: any) => x.name === name).value;
      expect(download).toContain(value);
    }
  });
});
