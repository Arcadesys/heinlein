import {mountStudio} from '../../src/studio';
import {syntheticProjects} from '../projectBridge';
import type {McpAccessRequest,McpAccessView} from '../../src/mcpAccess';
import '../../src/fonts.bundle';import '../../src/style.css';
import {applyAppearance,loadAppearance} from '../../src/appearance';
if(new URLSearchParams(location.search).has('contrast'))applyAppearance({...loadAppearance(),theme:'contrast'});
const fixture=syntheticProjects();let grant:McpAccessView={projectKey:null,scenes:[]};const calls:McpAccessRequest[]=[];
fixture.core.mcpRequest=async request=>{
  calls.push(structuredClone(request));
  if(request.action==='revoke')grant={projectKey:null,scenes:[]};
  if(request.action==='useSource'){
    const doc=await fixture.core.readDocument(request.repositoryId,request.path);
    const project=fixture.projects.find(p=>fixture.documents[p.id][request.path]===doc.text)!;
    const key=`source-key-${project.id}`;
    grant={projectKey:key,scenes:grant.projectKey===key?[...new Set([...grant.scenes,request.path])]:[request.path]};
  }
  return structuredClone(grant);
};
const app=mountStudio(document.querySelector<HTMLElement>('#app')!,fixture.core);
Object.assign(window,{mcpFixture:{fixture,app,calls,get grant(){return grant;}}});
