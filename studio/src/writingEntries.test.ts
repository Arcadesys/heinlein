import {expect,it} from 'vitest'; import {writingEntries} from './writingEntries'; import type {Document,Entry} from './localCore';
const file=(path:string):Entry=>({path,name:path.split('/').pop()!,kind:'file',sizeBytes:1}); const folder=(path:string):Entry=>({...file(path),kind:'directory'});
it('hides support files, generated outputs and empty filesystem folders',async()=>{
 const tree:Record<string,Entry[]>={empty:[], nested:[file('nested/story.md')], generated:[file('generated/chapter.md')]};
 const result=await writingEntries([file('README.md'),file('manifest.json'),folder('empty'),folder('nested'),folder('generated'),file('scene.markdown')],async path=>tree[path],async path=>({path,text:'Synthetic',contentHash:'hash',sizeBytes:1,frontmatter:null,generatedCompatibility:path==='generated/chapter.md'} as Document));
 expect(result.entries.map(item=>item.path)).toEqual(['nested','scene.markdown']); expect(result.incomplete).toBe(false);
});
it('keeps entries visible and reports uncertainty when inspection fails',async()=>{
 const result=await writingEntries([folder('unreadable'),file('unknown.md')],async()=>{throw new Error('unavailable');},async()=>{throw new Error('unavailable');});
 expect(result.entries.map(item=>item.path)).toEqual(['unreadable','unknown.md']); expect(result.incomplete).toBe(true);
});
