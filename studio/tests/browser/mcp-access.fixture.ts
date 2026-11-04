import {mountStudio} from '../../src/studio';
import {syntheticProjects} from '../projectBridge';
import type {McpAccessRequest,McpAccessView} from '../../src/mcpAccess';
import '../../src/fonts.bundle';import '../../src/style.css';
import {applyAppearance,loadAppearance} from '../../src/appearance';
if(new URLSearchParams(location.search).has('contrast'))applyAppearance({...loadAppearance(),theme:'contrast'});
const fixture=syntheticProjects();let grant:McpAccessView={projectKey:null,scenes:[],projectWide:false,projectName:null,setup:{available:true,configured:false,command:"codex mcp add heinlein -- '/Applications/Synthetic Studio' --heinlein-mcp '/private/synthetic selection'"}};const calls:McpAccessRequest[]=[];
const sessions=new Map<string,string>();const projectRequest=fixture.core.projectRequest!;
fixture.core.projectRequest=async request=>{const response=await projectRequest(request);if(response&&!Array.isArray(response)&&'projectKey' in response&&response.projectId)sessions.set(response.id,response.projectId);return response;};
fixture.core.mcpRequest=async request=>{
  calls.push(structuredClone(request));
  if(request.action==='revoke')grant={...grant,projectKey:null,scenes:[],projectName:null,projectWide:false};
  if(request.action==='setupCodex')grant={...grant,setup:{...grant.setup,configured:true}};
  if(request.action==='useProject'){
    const project=fixture.projects.find(p=>p.id===sessions.get(request.repositoryId))!;
    grant={...grant,projectKey:`source-key-${project.id}`,projectName:project.name,projectWide:true,scenes:Object.keys(fixture.documents[project.id]).filter(p=>/\.(md|markdown)$/i.test(p))};
  }
  return structuredClone(grant);
};
const app=mountStudio(document.querySelector<HTMLElement>('#app')!,fixture.core);
Object.assign(window,{mcpFixture:{fixture,app,calls,get grant(){return grant;}}});
