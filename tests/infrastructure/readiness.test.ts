import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resources, deployments, containers } from './manifests';

describe('Deployment configuration', () => {
  it('has a single unambiguous resource definition per kind/namespace/name', () => {
    const identities = resources.map(x => `${x.kind}/${x.metadata.namespace}/${x.metadata.name}`);
    expect(new Set(identities).size).toBe(identities.length);
  });
  it.each(containers.map(x => [x.deployment.sourceFile, x]))('%s avoids mutable latest tags', (_, { container }) => {
    expect(container.image).not.toMatch(/:latest$/);
    expect(container.image).toMatch(/[@:]/);
  });
  it.each(containers.map(x => [x.deployment.sourceFile, x]))('%s supplies probes, requests and limits', (_, { container }) => {
    expect(container.readinessProbe).toBeTruthy();
    expect(container.livenessProbe).toBeTruthy();
    expect(container.resources?.requests?.memory).toBeTruthy();
    expect(container.resources?.limits?.memory).toBeTruthy();
  });
  it('gives slow model initialization a startup probe', () => {
    for (const { deployment, container } of containers.filter(x => x.deployment.metadata.name.startsWith('acestep'))) expect(container.startupProbe, deployment.sourceFile).toBeTruthy();
  });
  it('loads the worker at startup and reads checkpoint shards in parallel', () => {
    const worker = deployments.find(x => x.metadata.name === 'acestep-xl-15-turbo')!;
    const env = Object.fromEntries(worker.spec.template.spec.containers[0].env.map((entry: any) => [entry.name, entry.value]));
    expect(env.ACESTEP_NO_INIT).toBe('false');
    expect(env.HF_ENABLE_PARALLEL_LOADING).toBe('true');
  });
  it('keeps all three XL models resident on the dedicated GPU node', () => {
    const worker = deployments.find(x => x.metadata.name === 'acestep-xl-15-turbo')!;
    const pod = worker.spec.template.spec;
    const env = Object.fromEntries(pod.containers[0].env.map((entry: any) => [entry.name, entry.value]));
    expect([env.ACESTEP_CONFIG_PATH, env.ACESTEP_CONFIG_PATH2, env.ACESTEP_CONFIG_PATH3]).toEqual([
      'acestep-v15-xl-turbo', 'acestep-v15-xl-sft', 'acestep-v15-xl-base',
    ]);
    expect(env.ACESTEP_OFFLOAD_DIT_TO_CPU).toBe('false');
    expect(env.ACESTEP_ON_DEMAND_MODEL_LOAD).toBe('false');
    expect(pod.nodeSelector['cloud.google.com/gke-nodepool']).toBe('resident');
    expect(pod.nodeSelector['cloud.google.com/gke-accelerator']).toBe('nvidia-tesla-a100');
  });
  it('retains checkpoint storage in the GPU node zone', () => {
    const volume = resources.find(x => x.kind === 'PersistentVolume' && x.metadata.name === 'checkpoints')!;
    const claim = resources.find(x => x.kind === 'PersistentVolumeClaim' && x.metadata.name === 'checkpoints')!;
    const zone = volume.spec.nodeAffinity.required.nodeSelectorTerms[0].matchExpressions[0].values[0];
    expect(volume.spec.persistentVolumeReclaimPolicy).toBe('Retain');
    expect(volume.spec.csi.volumeHandle).toContain(`/zones/${zone}/disks/`);
    expect(claim.spec.volumeName).toBe(volume.metadata.name);
  });
  it('disables container privilege escalation and runs the API as non-root', () => {
    for (const { container } of containers) {
      if (container.name === 'api') expect(container.securityContext?.runAsNonRoot).toBe(true);
      expect(container.securityContext?.allowPrivilegeEscalation).toBe(false);
      expect(container.securityContext?.capabilities?.drop).toContain('ALL');
    }
  });
  it('declares API availability across two replicas and disruption protection', () => {
    for (const d of deployments.filter(x => x.metadata.name === 'api')) expect(d.spec.replicas).toBeGreaterThanOrEqual(2);
    expect(resources.some(x => x.kind === 'PodDisruptionBudget')).toBe(true);
  });
  it('isolates the worker and keeps API replication bounded', () => {
    expect(resources.some(x => x.kind === 'NetworkPolicy')).toBe(true);
    expect(deployments.find(x => x.metadata.name === 'api')?.spec.replicas).toBe(2);
    expect(deployments.find(x => x.metadata.name === 'acestep-xl-15-turbo')?.spec.replicas).toBe(1);
  });
  it('loads API runtime credentials from the deployment secret', () => {
    const api = deployments.find(d => d.metadata.name === 'api')!;
    expect(api.spec.template.spec.containers[0].envFrom).toContainEqual({ secretRef: { name: 'backend-secrets' } });
  });
  it('starts the GPU worker without installing packages', () => {
    for (const d of deployments.filter(d => d.metadata.name.startsWith('acestep'))) {
      const c = d.spec.template.spec.containers[0];
      expect([...(c.command || []), ...(c.args || [])].join(' ')).not.toMatch(/pip install|git clone|apt-get/);
      expect(c.command).toContain('--no-sync');
    }
  });
  it('builds both stages with npm ci from the committed lockfile', () => {
    const dockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');
    expect(dockerfile.match(/RUN npm ci/g)?.length).toBe(2);
  });
});
