import {describe,expect,it} from 'vitest';
import {join} from 'node:path';
import {agentProfile} from '../apps/desktop/src/profile';
import {agentLoginItemSettings} from '../apps/desktop/src/login-items';

describe('Electron Agent profile compatibility',()=>{
  it('keeps the pre-rename macOS profile',()=>{
    expect(agentProfile('/Library/Application Support','darwin',()=>false)).toBe(join('/Library/Application Support','@codexer','desktop'));
  });
  it('uses the shipped Windows native profile before the older Electron profile',()=>{
    expect(agentProfile('/appdata','win32',()=>true)).toBe(join('/appdata','Codexer'));
  });
  it('finds the older Electron Windows profile and uses the stable directory for fresh installs',()=>{
    const legacy=join('/appdata','@codexer','desktop');
    expect(agentProfile('/appdata','win32',path=>path===join(legacy,'settings.json'))).toBe(legacy);
    expect(agentProfile('/appdata','win32',()=>false)).toBe(join('/appdata','Codexer'));
  });
});

it('replaces the historical Windows Agent startup entries while preserving the preference',()=>{
  const entries=agentLoginItemSettings('win32',true,'C:/Apps/Codexer Agent.exe');
  expect(entries.slice(0,-1)).toEqual(['Codexer','@codexer/desktop','com.codexer.connector'].map(name=>({name,openAtLogin:false})));
  expect(entries.at(-1)).toEqual({name:'Codexer Agent',openAtLogin:true,path:'C:/Apps/Codexer Agent.exe',args:[]});
  expect(agentLoginItemSettings('darwin',false,'ignored')).toEqual([{openAtLogin:false}]);
});
