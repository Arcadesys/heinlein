// @vitest-environment jsdom
import {describe,it,expect,vi} from 'vitest';
import {createNativePreferences,PREFERENCE_KEYS,type PreferenceSnapshot,type PreferenceBridge} from './preferences';
const key='heinlein-studio-zoom-v1';
function memory(entries:Record<string,string>={}){const map=new Map(Object.entries(entries));return{map,getItem:(k:string)=>map.get(k)??null,setItem:(k:string,v:string)=>{map.set(k,v);}};}
function host(values:Record<string,string>={},migrated=false){
 let disk:PreferenceSnapshot={schemaVersion:1,revision:0,migrated,values,legacy:{}};
 const bridge=vi.fn<PreferenceBridge>(async r=>{
  if(r.kind==='import'&&!disk.migrated){disk={...disk,revision:disk.revision+1,migrated:true,values:{...r.values,...disk.values},legacy:r.values};}
  if(r.kind==='set'){
   if(r.expectedRevision!==disk.revision)throw Error('Settings changed in another window');
   disk={...disk,revision:disk.revision+1,values:{...disk.values,[r.key]:r.value}};
  }
  return structuredClone(disk);
 });
 return{bridge,read:()=>structuredClone(disk)};
}
describe('native preference lifecycle',()=>{
 it('imports exactly the allowlist once, preserves raw records and leaves browser storage untouched',async()=>{
  const legacy=memory(Object.fromEntries(PREFERENCE_KEYS.map(k=>[k,k==='heinlein-studio-writing-v1'?'{unreadable progress':'synthetic value'])));
  legacy.setItem('heinlein.conversation.v1:private','never export');legacy.setItem('chatgpt-auth','never export');const before=[...legacy.map];
  const h=host({[key]:'175'});const s=createNativePreferences(h.bridge,legacy);await s.ready;
  expect(s.getItem(key)).toBe('175');expect(h.read().legacy[key]).toBe('synthetic value');expect(Object.keys(h.read().legacy).sort()).toEqual([...PREFERENCE_KEYS].sort());expect([...legacy.map]).toEqual(before);
  const restart=createNativePreferences(h.bridge,memory({[key]:'100'}));await restart.ready;expect(restart.getItem(key)).toBe('175');expect(h.bridge.mock.calls.filter(([r])=>r.kind==='import')).toHaveLength(1);
 });
 it('survives an app restart/update with empty WebKit storage',async()=>{
  const h=host();const first=createNativePreferences(h.bridge,memory({[key]:'150','heinlein-studio-writing-v1':'{"version":1,"goal":1250,"days":{}}'}));await first.ready;
  first.setItem(key,'200');await first.flush();const second=createNativePreferences(h.bridge,memory());await second.ready;
  expect(second.getItem(key)).toBe('200');expect(second.getItem('heinlein-studio-writing-v1')).toContain('1250');
 });
 it('serializes overlapping choices without dropping other fields',async()=>{
  const h=host();const s=createNativePreferences(h.bridge,memory());await s.ready;
  s.setItem(key,'150');s.setItem('heinlein-studio-fonts-v1','{"text":"Courier New"}');s.setItem(key,'175');await s.flush();
  expect(h.read().values).toMatchObject({[key]:'175','heinlein-studio-fonts-v1':'{"text":"Courier New"}'});expect(s.failed()).toBe(false);
 });
 it('shows failed writes, retains pending choices and flushes them after explicit retry',async()=>{
  const h=host();const s=createNativePreferences(h.bridge,memory());await s.ready;
  h.bridge.mockRejectedValueOnce(Error('Disk full'));s.setItem(key,'150');await expect(s.flush()).rejects.toThrow('Disk full');expect(s.message()).toContain('not saved');expect(s.getItem(key)).toBe('150');
  s.setItem(key,'175');await s.retry();await s.flush();expect(h.read().values[key]).toBe('175');
 });
 it('never writes defaults after a load/schema failure',async()=>{
  const bridge=vi.fn<PreferenceBridge>().mockRejectedValue(Error('Newer preferences schema'));const s=createNativePreferences(bridge,memory({[key]:'150'}));await s.ready;
  expect(s.getItem(key)).toBe('150');expect(()=>s.setItem(key,'100')).toThrow();await expect(s.flush()).resolves.toBeUndefined();expect(s.retryable()).toBe(false);expect(bridge).toHaveBeenCalledTimes(1);
 });
 it('does not need access to WebKit after migration',async()=>{
  const h=host({[key]:'175'},true);const s=createNativePreferences(h.bridge,{getItem:()=>{throw Error('WebKit denied');},setItem:()=>{throw Error('must not write');}});await s.ready;
  expect(s.failed()).toBe(false);expect(s.getItem(key)).toBe('175');
 });
 it('refuses unknown write keys and revision conflicts instead of overwriting another window',async()=>{
  const h=host({},true);const a=createNativePreferences(h.bridge,memory());const b=createNativePreferences(h.bridge,memory());await Promise.all([a.ready,b.ready]);
  expect(()=>a.setItem('private-file','contents')).toThrow('Unsupported');a.setItem(key,'150');await a.flush();b.setItem(key,'200');await expect(b.flush()).rejects.toThrow('another window');expect(h.read().values[key]).toBe('150');
 });
});
