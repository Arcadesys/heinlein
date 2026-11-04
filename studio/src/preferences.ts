import type {LocalCore} from './localCore';

export const PREFERENCE_KEYS = [
  'heinlein-studio-appearance-v1', 'heinlein-studio-fonts-v1', 'heinlein-studio-zoom-v1',
  'heinlein-studio-navigation-v1', 'heinlein-studio-collapsed-v1',
  'heinlein-studio-custom-theme-v1', 'heinlein-studio-writing-v1', 'heinlein-studio-sound-v1',
] as const;
export type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;
export interface PreferenceSnapshot {schemaVersion:1; revision:number; migrated:boolean; values:Record<string,string>; legacy:Record<string,string>}
export type PreferenceRequest = {kind:'load'} | {kind:'import';values:Record<string,string>} | {kind:'set';expectedRevision:number;key:string;value:string};
export type PreferenceBridge = (request:PreferenceRequest)=>Promise<PreferenceSnapshot>;

/** A synchronous UI cache with serialized, revision-checked native commits. No WebKit writes. */
export function createNativePreferences(bridge:PreferenceBridge, legacy:PreferenceStorage) {
  let snapshot:PreferenceSnapshot={schemaVersion:1,revision:0,migrated:false,values:{},legacy:{}};
  const values:Record<string,string>=Object.create(null);
  const pending:{key:string;value:string}[]=[];
  let error='', initialized=false, pumping:Promise<void>|null=null;
  const listeners=new Set<()=>void>();
  const notify=()=>listeners.forEach(fn=>fn());
  const message=()=>error?`Settings are not saved: ${error}`:pending.length?'Saving settings…':'Settings saved on this device';
  async function pump():Promise<void> {
    if(pumping)return pumping;
    if(error||!initialized)return;
    pumping=(async()=>{
      while(pending.length&&!error){
        const change=pending[0];
        try {snapshot=await bridge({kind:'set',expectedRevision:snapshot.revision,...change});pending.shift();}
        catch(e){error=String(e);}
        notify();
      }
    })();
    try{await pumping;}finally{pumping=null;}
    if(pending.length&&!error)await pump();
  }
  const ready=(async()=>{
    try {
      snapshot=await bridge({kind:'load'});
      Object.assign(values,snapshot.values);
      if(!snapshot.migrated){
        const imported:Record<string,string>={};
        for(const key of PREFERENCE_KEYS){const raw=legacy.getItem(key);if(raw!==null)imported[key]=raw;}
        // Both preferences and progress, and the migration receipt, commit in one envelope.
        snapshot=await bridge({kind:'import',values:imported});
        Object.assign(values,snapshot.values);
      }
      initialized=true;
    }catch(e){
      error=String(e);
      // Display recoverable legacy choices, but never overwrite unseen/corrupt native data.
      for(const key of PREFERENCE_KEYS){try{const raw=legacy.getItem(key);if(values[key]===undefined&&raw!==null)values[key]=raw;}catch{/* preserve read-only fallback */}}
    }
    notify();
  })();
  return {
    ready,
    getItem(key:string){return values[key]??null;},
    setItem(key:string,value:string){
      if(!(PREFERENCE_KEYS as readonly string[]).includes(key))throw Error('Unsupported preference');
      if(!initialized)throw Error(error||'Settings have not loaded');
      values[key]=value;pending.push({key,value});notify();void pump();
    },
    message, failed:()=>!!error, retryable:()=>initialized,
    subscribe(fn:()=>void){listeners.add(fn);fn();return()=>{listeners.delete(fn);};},
    async retry(){if(!initialized)return;error='';notify();await pump();},
    async flush(){await ready;if(!initialized)return;await pump();if(error||pending.length)throw Error(message());},
  };
}
let native:ReturnType<typeof createNativePreferences>|null=null;
export function preferenceStorage():PreferenceStorage {return native??globalThis.localStorage;}
export async function initializePreferences(core:Pick<LocalCore,'available'|'preferencesRequest'>, legacy:PreferenceStorage={getItem:key=>globalThis.localStorage.getItem(key),setItem:(key,value)=>globalThis.localStorage.setItem(key,value)}){
  native=core.available()&&core.preferencesRequest?createNativePreferences(core.preferencesRequest,legacy):null;
  await native?.ready;
}
export async function flushPreferences(){await native?.flush();}
export function bindPreferenceStatus(root:HTMLElement,note:HTMLElement){
  if(!native)return()=>{};
  const store=native;
  const alert=document.createElement('div');alert.className='preference-warning';alert.setAttribute('role','alert');
  const text=document.createElement('span');const retry=document.createElement('button');retry.type='button';retry.textContent='Retry saving settings';retry.addEventListener('click',()=>{void store.retry();});
  alert.append(text,retry);root.append(alert);
  const unsubscribe=store.subscribe(()=>{note.textContent=store.message();text.textContent=store.message()+(store.retryable()?'':' Reopen the app to retry loading settings.');retry.hidden=!store.retryable();alert.hidden=!store.failed();});
  return()=>{unsubscribe();alert.remove();};
}
