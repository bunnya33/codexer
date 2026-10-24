import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {AgentCredentials} from '../../pc-agent/src/auth';
const execute=promisify(execFile);

export async function readNativeCredentials(directory:string,helper:string):Promise<AgentCredentials|null> {
  const file=join(directory,'session.native.enc');
  const data=await readFile(file).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(!data)return null;
  if(data.length>65636)throw new Error('invalid-native-credential');
  let text:string;
  if(process.platform==='darwin') {
    const result=await execute(helper,[file],{timeout:30000,maxBuffer:65536});text=result.stdout;
  } else if(process.platform==='win32') {
    // Windows ships PowerShell/.NET. DPAPI stays scoped to the current user;
    // the path is passed in the environment, never interpolated into code.
    const powershell=join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    const script="Add-Type -AssemblyName System.Security; $sealed=[IO.File]::ReadAllBytes($env:CODEXER_MIGRATION_FILE); $plain=[Security.Cryptography.ProtectedData]::Unprotect($sealed,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($plain))";
    const result=await execute(powershell,['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{env:{...process.env,CODEXER_MIGRATION_FILE:file},windowsHide:true,timeout:30000,maxBuffer:100000});
    text=Buffer.from(result.stdout.trim(),'base64').toString('utf8');
  } else throw new Error('unsupported-native-credential');
  return JSON.parse(text) as AgentCredentials;
}
