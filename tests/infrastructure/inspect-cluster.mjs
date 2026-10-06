import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const namespace = process.env.RAWCHUNKS_NAMESPACE || 'rawchunks';
const expected = process.env.RAWCHUNKS_CONTEXT || 'gke_gen-lang-client-0035632562_us-central1-a_rawchunks';
const current = execFileSync('kubectl', ['config','current-context'], { encoding: 'utf8' }).trim();
if (current !== expected) throw new Error('Refusing to inspect an unexpected Kubernetes context');
function read(resource, namespaced = true) {
 const args=['--request-timeout=20s','get',resource];
 if(namespaced)args.push('-n',namespace);
 args.push('-o','json');
 return JSON.parse(execFileSync('kubectl',args,{encoding:'utf8',maxBuffer:8*1024*1024})).items;
}
const all=read('deployment,pod,service,pvc,ingress,endpointslice');
const controls=read('networkpolicy,hpa,pdb,resourcequota,limitrange');
const nodes=read('nodes',false);
const snapshot={timestamp:new Date().toISOString(),context:current,namespace,
 deployments:all.filter(x=>x.kind==='Deployment').map(x=>({name:x.metadata.name,replicas:x.spec.replicas,readyReplicas:x.status.readyReplicas||0,
  strategy:x.spec.strategy,securityContext:x.spec.template.spec.securityContext,volumes:x.spec.template.spec.volumes,
  containers:x.spec.template.spec.containers.map(c=>({name:c.name,image:c.image,resources:c.resources,readinessProbe:c.readinessProbe,livenessProbe:c.livenessProbe,startupProbe:c.startupProbe,securityContext:c.securityContext,
   env:c.env?.map(e=>({name:e.name,source:e.valueFrom?'reference':'literal',secret:e.valueFrom?.secretKeyRef?.name,key:e.valueFrom?.secretKeyRef?.key,
    value: /MODEL|CONFIG|OFFLOAD|WORKERS|SAVE_MEMORY|CHECKPOINTS|HF_HOME|ON_DEMAND/.test(e.name)&&e.value?e.value:undefined}))}))})),
 pods:all.filter(x=>x.kind==='Pod').map(x=>({name:x.metadata.name,phase:x.status.phase,ready:x.status.conditions?.find(c=>c.type==='Ready')?.status,
  containers:x.status.containerStatuses?.map(c=>({name:c.name,imageID:c.imageID,restarts:c.restartCount,ready:c.ready,lastReason:c.lastState?.terminated?.reason}))})),
 services:all.filter(x=>x.kind==='Service').map(x=>({name:x.metadata.name,type:x.spec.type,selector:x.spec.selector,ports:x.spec.ports})),
 storage:all.filter(x=>x.kind==='PersistentVolumeClaim').map(x=>({name:x.metadata.name,phase:x.status.phase,capacity:x.status.capacity,accessModes:x.spec.accessModes})),
 endpoints:all.filter(x=>x.kind==='EndpointSlice').map(x=>({service:x.metadata.labels['kubernetes.io/service-name'],ready:x.endpoints.filter(e=>e.conditions.ready).length})),
 controls:controls.map(x=>({kind:x.kind,name:x.metadata.name})),
 nodes:nodes.map(x=>({name:x.metadata.name,capacity:x.status.capacity,allocatable:x.status.allocatable,ready:x.status.conditions.find(c=>c.type==='Ready')?.status,kubelet:x.status.nodeInfo.kubeletVersion}))};
const destination=fileURLToPath(new URL('../results/cluster.json',import.meta.url));
mkdirSync(fileURLToPath(new URL('../results/',import.meta.url)),{recursive:true});
writeFileSync(destination,JSON.stringify(snapshot,null,2));
console.log(JSON.stringify(snapshot,null,2));
