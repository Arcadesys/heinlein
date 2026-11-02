// @vitest-environment jsdom
import {beforeEach,it,expect,vi,afterEach} from 'vitest';
import {conversationKey,loadConversation,saveConversation} from './questionHistoryStore';
beforeEach(()=>localStorage.clear());afterEach(()=>vi.restoreAllMocks());
const turn=(n:number)=>({question:`Question ${n}`,answer:{requestId:`r${n}`,text:'A reply 🐺',model:'model',incomplete:false},contextBytes:12,scenePath:'scene.md'});
it('persists exact Unicode messages and separates project, account and model',()=>{
 const key=conversationKey('book','account','model');saveConversation(key,{turns:[turn(1)],draft:'Follow-up 🐺',forgotten:0});expect(loadConversation(key)).toEqual({turns:[turn(1)],draft:'Follow-up 🐺',forgotten:0});
 for(const [p,a,m] of [['other','account','model'],['book','other','model'],['book','account','other']])expect(loadConversation(conversationKey(p,a,m)).turns).toEqual([]);
});
it('bounds retained history and reports the number removed',()=>{const key=conversationKey('b','a','m');saveConversation(key,{turns:Array.from({length:101},(_,i)=>turn(i)),draft:'',forgotten:0});expect(loadConversation(key).turns).toHaveLength(100);expect(loadConversation(key).forgotten).toBe(1);});
it('does not overwrite unreadable history while loading',()=>{const key=conversationKey('b','a','m');localStorage.setItem(key,'invalid');expect(()=>loadConversation(key)).toThrow();expect(localStorage.getItem(key)).toBe('invalid');});
it('reports write failure without deleting an existing saved copy',()=>{const key=conversationKey('b','a','m');saveConversation(key,{turns:[turn(1)],draft:'',forgotten:0});vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw Error('Quota');});expect(()=>saveConversation(key,{turns:[turn(2)],draft:'',forgotten:0})).toThrow();expect(loadConversation(key).turns[0].question).toBe('Question 1');});

it('never restores persisted revision controls or raw source snapshots',()=>{const key=conversationKey('b','a','m');localStorage.setItem(key,JSON.stringify({turns:[{...turn(1),revision:{snapshot:{source:'Private source'}}}],draft:'',forgotten:0}));expect(JSON.stringify(loadConversation(key))).not.toContain('Private source');expect(loadConversation(key).turns[0]).not.toHaveProperty('revision');});
