import {expect,it} from 'vitest';
import {freshStatusCycle,statusReturns,controlReady,type BackendEvent} from './statusCycle';
it('does not accept stale available text before a newly opened native status cycle',()=>{
  const events:BackendEvent[]=[{stage:'returned',action:'status',index:0,state:'available'}];
  const before=statusReturns(events);
  expect(freshStatusCycle(before,events,true,false,true)).toBe(false);
  events.push({stage:'entered',action:'status',index:0});
  expect(freshStatusCycle(before,events,true,true,false)).toBe(false);
  events.push({stage:'returned',action:'status',index:0,state:'available'});
  expect(freshStatusCycle(before,events,true,true,true)).toBe(false);
  expect(freshStatusCycle(before,events,false,false,true)).toBe(false);
  expect(freshStatusCycle(before,events,true,false,false)).toBe(false);
  expect(freshStatusCycle(before,events,true,false,true)).toBe(true);
});

it('never treats an enabled result control as ready while action finalization is pending',()=>{
  expect(controlReady(true,true,true)).toBe(false);
  expect(controlReady(true,false,false)).toBe(false);
  expect(controlReady(false,false,true)).toBe(false);
  expect(controlReady(true,false,true)).toBe(true);
});
