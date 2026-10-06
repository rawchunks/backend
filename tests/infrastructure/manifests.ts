import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments } from 'yaml';

export type Resource = Record<string, any>;
const directory = fileURLToPath(new URL('../../k8s/', import.meta.url));
export const resources: Resource[] = readdirSync(directory).filter(name => name.endsWith('.yaml')).flatMap(file =>
  parseAllDocuments(readFileSync(`${directory}/${file}`, 'utf8')).map(doc => {
    if (doc.errors.length) throw doc.errors[0];
    return { ...doc.toJS(), sourceFile: file };
  }),
);
export const deployments = resources.filter(x => x.kind === 'Deployment');
export const containers = deployments.flatMap(d => d.spec.template.spec.containers.map((container: any) => ({ deployment: d, container })));
