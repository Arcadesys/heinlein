import type {QuestionAnswer} from './localCore';
export interface SavedQuestionTurn {question:string;answer:QuestionAnswer;contextBytes:number;scenePath?:string;proposalId?:string}
export interface SavedConversation {turns:SavedQuestionTurn[];draft:string;forgotten:number}
const PREFIX='heinlein.conversation.v1:';
export const SAVED_CHAT_LIMITS={turns:100,bytes:512000};
const bytes=(s:string)=>new TextEncoder().encode(s).length;
export function conversationKey(project:string,account:string,model:string){return PREFIX+JSON.stringify([project,account,model]);}
export function saveConversation(key:string,value:SavedConversation){
 if(bytes(value.draft)>16000)throw Error('The unsent message is too large to save.');
 const copy={...value,turns:[...value.turns]};
 while(copy.turns.length>SAVED_CHAT_LIMITS.turns||bytes(JSON.stringify(copy))>SAVED_CHAT_LIMITS.bytes){if(!copy.turns.length)throw Error('Conversation draft is too large to save.');copy.turns.shift();copy.forgotten++;}
 localStorage.setItem(key,JSON.stringify(copy));return copy;
}
export function loadConversation(key:string):SavedConversation{
 const raw=localStorage.getItem(key);if(!raw)return{turns:[],draft:'',forgotten:0};
 if(bytes(raw)>SAVED_CHAT_LIMITS.bytes)throw Error('Saved conversation exceeds its limit.');
 const value=JSON.parse(raw);
 if(!value||!Array.isArray(value.turns)||value.turns.length>SAVED_CHAT_LIMITS.turns||typeof value.draft!=='string'||bytes(value.draft)>16000||!Number.isSafeInteger(value.forgotten)||value.forgotten<0)throw Error('Saved conversation is unreadable.');
 for(const t of value.turns){if(!t||typeof t.question!=='string'||bytes(t.question)>4000||!t.answer||typeof t.answer.text!=='string'||bytes(t.answer.text)>32000||typeof t.answer.model!=='string'||typeof t.answer.requestId!=='string'||typeof t.answer.incomplete!=='boolean'||!Number.isSafeInteger(t.contextBytes)||t.contextBytes<0||(t.scenePath!==undefined&&typeof t.scenePath!=='string')||(t.proposalId!==undefined&&typeof t.proposalId!=='string'))throw Error('Saved conversation is unreadable.');}
 return {draft:value.draft,forgotten:value.forgotten,turns:value.turns.map((t:SavedQuestionTurn)=>({question:t.question,answer:{requestId:t.answer.requestId,text:t.answer.text,model:t.answer.model,incomplete:t.answer.incomplete,inputTokens:typeof t.answer.inputTokens==='number'?t.answer.inputTokens:undefined,outputTokens:typeof t.answer.outputTokens==='number'?t.answer.outputTokens:undefined},contextBytes:t.contextBytes,scenePath:t.scenePath,proposalId:t.proposalId}))};
}
