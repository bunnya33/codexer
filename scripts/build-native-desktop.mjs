import {spawn} from 'node:child_process';
import {join} from 'node:path';

const platform=process.platform==='darwin'?'macos':process.platform==='win32'?'windows':null;
if(!platform)throw new Error('Desktop native packages must be built on macOS or Windows.');
const child=spawn(process.execPath,[join(import.meta.dirname,`build-native-${platform}.mjs`),...process.argv.slice(2)],{stdio:'inherit'});
child.once('error',error=>{console.error(error);process.exitCode=1;});
child.once('exit',(code,signal)=>{process.exitCode=code??(signal?1:0);});
