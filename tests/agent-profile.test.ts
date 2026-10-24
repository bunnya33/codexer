import {describe,expect,it} from 'vitest';
import {join} from 'node:path';
import {agentProfile} from '../apps/desktop/src/profile';

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
