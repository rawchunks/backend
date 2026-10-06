import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const targets = {
  api: { manifest: 'k8s/backend.yaml', source: '.' },
  worker: { manifest: 'k8s/acestep-xl-15.yaml', source: 'worker' },
};
const target = targets[process.argv[2] ?? 'api'];
if (!target) throw new Error('Expected deployment target: api or worker');
const run = (command, args, capture = false) => execFileSync(command, args, {
  cwd: root, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
});
const context = process.env.RAWCHUNKS_CONTEXT ?? run('kubectl', ['config', 'current-context'], true).trim();
const kubectl = (args, capture = false) => run('kubectl', ['--context', context, ...args], capture);
const resources = kubectl(['create', '--dry-run=client', '-f', target.manifest, '-o',
  'jsonpath={.kind}|{.metadata.name}|{.metadata.namespace}|{.spec.template.spec.containers[*].image}|{.spec.template.spec.containers[*].name}{"\\n"}',
], true).trim().split('\n').map(line => line.split('|'));
const deployments = resources.filter(resource => resource[0] === 'Deployment');
if (!deployments.length) throw new Error('No deployment in target manifest');
for (const [, name, namespace, image, containerName] of deployments) {
  if (!name || !namespace || !image || image.includes(' ') || !containerName || containerName.includes(' ')) throw new Error('Expected one intended container per deployment');
}
const repositoryOf = image => image.split('@')[0].replace(/:[^/]+$/, '');
const repository = repositoryOf(deployments[0][3]);
if (deployments.some(resource => repositoryOf(resource[3]) !== repository)) throw new Error('Intended deployments must share the built image repository');
const tag = `${repository}:build-${Date.now()}-${randomUUID().slice(0, 8)}`;
// A manifest may include a newly provisioned trainer; apply creates it after the build.
for (const [, name, namespace] of deployments) kubectl(['get', 'deployment', name, '-n', namespace, '--ignore-not-found']);
run('gcloud', ['builds', 'submit', '--tag', tag, target.source]);
const digest = run('gcloud', ['artifacts', 'docker', 'images', 'describe', tag, '--format=value(image_summary.digest)'], true).trim();
if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('Registry returned no immutable image digest');
const image = `${repository}@${digest}`;
const path = new URL(target.manifest, import.meta.url);
const manifest = readFileSync(path, 'utf8');
let updated = manifest;
for (const current of new Set(deployments.map(resource => resource[3]))) {
  const expected = deployments.filter(resource => resource[3] === current).length;
  if (updated.split(current).length - 1 !== expected) throw new Error('Image occurrences must match the intended deployment containers');
  updated = updated.replaceAll(current, image);
}
writeFileSync(path, updated);
kubectl(['apply', '-f', target.manifest]);
for (const [, name, namespace, , containerName] of deployments) {
  kubectl(['rollout', 'status', `deployment/${name}`, '-n', namespace, '--timeout=20m']);
  const running = JSON.parse(kubectl(['get', 'deployment', name, '-n', namespace, '-o', 'json'], true));
  if (running.spec.template.spec.containers.find(item => item.name === containerName)?.image !== image) throw new Error('Deployment image changed during rollout');
  console.log(`${name}: ${image}`);
}
